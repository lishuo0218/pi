// Session store: authoritative message list + streaming reconstruction per
// json.md "Reconstruct streaming messages". message_end replaces wholesale.
import type {
  AgentMessage,
  AssistantContent,
  AssistantMessage,
  ToolCallContent,
  Usage,
} from "./protocol";

/** Argument keys pi's tools use for their target file (edit/read/write). */
const PATH_KEYS = ['"path"', '"file_path"', '"filePath"'];
/** Prefix of the streamed arguments scanned for the target file; pi puts it first. */
const PATH_SCAN_LIMIT = 4096;

export type AgentState = {
  model: { id: string; name: string; provider: string } | null;
  thinkingLevel: string | null;
  isStreaming: boolean;
  sessionName: string | null;
  sessionFile: string | null;
  /** null = unknown (get_state did not report it). */
  autoCompactionEnabled: boolean | null;
  steeringMode: string | null;
  followUpMode: string | null;
};

/** A message row in the UI: either a completed message or a streaming placeholder. */
export type StreamRow =
  | { kind: "message"; message: AgentMessage; id: string }
  | { kind: "streaming"; message: AssistantMessage; id: string };

let rowSeq = 0;
const nextRowId = (): string => `row-${++rowSeq}`;

/**
 * Decode the JSON string literal that starts at `start` (just past the opening
 * quote) and report whether its closing quote has arrived. The value may still
 * be streaming, so an unterminated literal (or a dangling backslash) yields the
 * prefix decoded so far instead of failing.
 */
function decodeJsonString(raw: string, start: number): { value: string; complete: boolean } {
  let end = start;
  while (end < raw.length && raw[end] !== '"') {
    if (raw[end] === "\\") end++; // the escaped char is never the terminator
    end++;
  }
  const complete = end < raw.length;
  const body = raw.slice(start, end);
  const text = body.endsWith("\\") ? body.slice(0, -1) : body;
  try {
    return { value: JSON.parse(`"${text}"`) as string, complete };
  } catch {
    return { value: text, complete };
  }
}

/**
 * Target file of a tool call whose arguments are still streaming, read from the
 * JSON text seen so far: the value may be an unterminated prefix. Null until a
 * key pi uses for paths has arrived.
 */
export function streamedToolPath(raw: string): { key: string; value: string; complete: boolean } | null {
  // The earliest match decides: a tool call uses one of these names, and a
  // later occurrence can only sit inside another argument's text.
  let best: { at: number; key: string } | null = null;
  for (const key of PATH_KEYS) {
    const at = raw.indexOf(key);
    if (at >= 0 && (best === null || at < best.at)) best = { at, key };
  }
  if (best === null) return null;
  const colon = raw.indexOf(":", best.at + best.key.length);
  if (colon < 0) return null;
  const quote = raw.indexOf('"', colon + 1);
  if (quote < 0) return null;
  const { value, complete } = decodeJsonString(raw, quote + 1);
  return { key: best.key.slice(1, -1), value, complete };
}

/** Buffered argument prefix of one streaming tool call. */
type PathScan = {
  buffer: string;
  /** Target file decoded from the prefix; null until its key has arrived. */
  path: { key: string; value: string } | null;
  /** The path's string literal is closed: later deltas cannot change it. */
  complete: boolean;
};

export class SessionStore {
  rows: StreamRow[] = [];
  /** Streamed argument prefix per tool-call block, for `toolcall_delta`. */
  private toolCallPaths = new Map<number, PathScan>();
  state: AgentState = {
    model: null,
    thinkingLevel: null,
    isStreaming: false,
    sessionName: null,
    sessionFile: null,
    autoCompactionEnabled: null,
    steeringMode: null,
    followUpMode: null,
  };
  /** Bumped on every mutation; the UI listens to this via subscription. */
  version = 0;
  /**
   * Bumped when the store switches to another session, so views that hold
   * per-session view state (scroll position, visible slice) remount instead of
   * carrying the previous session's state into the new one.
   */
  epoch = 0;
  /**
   * Messages from before the last compaction, fetched from get_entries and
   * revealed by "load earlier": get_messages cannot see them anymore.
   */
  private earlier: AgentMessage[] = [];
  private subscribers = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  private emit(): void {
    this.version++;
    for (const fn of this.subscribers) fn();
  }

  reset(): void {
    this.rows = [];
    this.earlier = [];
    this.toolCallPaths.clear();
    this.emit();
  }

  /** Hydrate from get_messages + get_state (F-01). */
  hydrate(messages: AgentMessage[], state: AgentState): void {
    this.noteSession(state.sessionFile);
    this.rows = messages.map((message) => ({ kind: "message", message, id: nextRowId() }));
    this.earlier = [];
    this.toolCallPaths.clear();
    this.state = state;
    this.emit();
  }

  /** Count a session switch so per-session view state resets; see `epoch`. */
  private noteSession(sessionFile: string | null): void {
    if ((sessionFile ?? "") === (this.state.sessionFile ?? "")) return;
    // An empty session has no file yet, so "no session file" is its identity.
    if (this.rows.length > 0) this.epoch++;
  }

  /** Pre-compaction messages get_entries reported; taken by "load earlier". */
  setEarlier(messages: AgentMessage[]): void {
    this.earlier = messages;
    this.emit();
  }

  hasEarlier(): boolean {
    return this.earlier.length > 0;
  }

  /** Hand the pre-compaction messages to the caller, which prepends them. */
  takeEarlier(): AgentMessage[] {
    const messages = this.earlier;
    this.earlier = [];
    return messages;
  }

  /** Insert rows in front of the transcript (older history, revealed later). */
  prepend(messages: AgentMessage[]): void {
    this.rows = [
      ...messages.map((message) => ({ kind: "message", message, id: nextRowId() }) as StreamRow),
      ...this.rows,
    ];
    this.emit();
  }

  setState(patch: Partial<AgentState>): void {
    if (patch.sessionFile !== undefined) this.noteSession(patch.sessionFile);
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  appendMessage(message: AgentMessage): void {
    this.rows.push({ kind: "message", message, id: nextRowId() });
    this.emit();
  }

  /** message_start of an assistant message begins a streaming row. */
  startStreaming(message: AssistantMessage): void {
    const last = this.rows[this.rows.length - 1];
    // A replayed stream (bridge_resume) restarts the message: replace the
    // trailing streaming placeholder instead of appending a second copy. Its
    // argument deltas replay from the start too, so drop what was buffered.
    this.toolCallPaths.clear();
    if (last && last.kind === "streaming") {
      this.rows[this.rows.length - 1] = { kind: "streaming", message, id: last.id };
    } else {
      this.rows.push({ kind: "streaming", message, id: nextRowId() });
    }
    this.emit();
  }

  /** message_end: replace the streaming row (or append) with the authoritative message. */
  finishStreaming(message: AgentMessage): void {
    const last = this.rows[this.rows.length - 1];
    this.toolCallPaths.clear();
    if (last && last.kind === "streaming") {
      this.rows[this.rows.length - 1] = { kind: "message", message, id: last.id };
    } else {
      this.appendMessage(message);
    }
    this.emit();
  }

  /** Apply one delta-only assistantMessageEvent to the streaming row (F-03). */
  applyAssistantEvent(
    event:
      | { type: "text_start"; contentIndex: number }
      | { type: "text_delta"; contentIndex: number; delta: string }
      | { type: "text_end"; contentIndex: number; content: string }
      | { type: "thinking_start"; contentIndex: number }
      | { type: "thinking_delta"; contentIndex: number; delta: string }
      | { type: "thinking_end"; contentIndex: number; content: string }
      | { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
      | { type: "toolcall_delta"; contentIndex: number; delta: string }
      | { type: "toolcall_end"; contentIndex: number; toolCall: AssistantContent },
    usage?: Usage,
  ): void {
    const last = this.rows[this.rows.length - 1];
    if (!last || last.kind !== "streaming") {
      // The page was reloaded (or another session was attached) in the middle
      // of a turn: message_start is gone, deltas are not. Open an empty
      // streaming row so the rest of the turn still renders; message_end
      // replaces it with the authoritative message.
      this.startStreaming({
        role: "assistant",
        content: [],
        api: "",
        provider: "",
        model: "",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "pending",
        timestamp: Date.now(),
      });
    }
    const row = this.rows[this.rows.length - 1];
    if (!row || row.kind !== "streaming") return;
    const content = row.message.content;
    const idx = event.contentIndex;
    // Grow sparse content array up to contentIndex.
    while (content.length <= idx) content.push({ type: "text", text: "" });
    const block = content[idx];

    switch (event.type) {
      case "text_start":
        content[idx] = { type: "text", text: "" };
        break;
      case "text_delta":
        content[idx] = { type: "text", text: (block as { text: string }).text + event.delta };
        break;
      case "text_end":
        content[idx] = { type: "text", text: event.content };
        break;
      case "thinking_start":
        content[idx] = { type: "thinking", thinking: "" };
        break;
      case "thinking_delta":
        content[idx] = {
          type: "thinking",
          thinking: (block as { thinking: string }).thinking + event.delta,
        };
        break;
      case "thinking_end":
        content[idx] = { type: "thinking", thinking: event.content };
        break;
      case "toolcall_start":
        content[idx] = { type: "toolCall", id: event.id, name: event.toolName, arguments: {} };
        this.toolCallPaths.delete(idx);
        break;
      case "toolcall_delta": {
        // Wire input: `delta` is JSON text for the block toolcall_start opened.
        const call = block as ToolCallContent;
        const path = this.applyToolCallDelta(idx, event.delta);
        content[idx] = {
          type: "toolCall",
          id: call.id,
          name: call.name,
          arguments: path === null ? {} : { [path.key]: path.value },
        };
        break;
      }
      case "toolcall_end":
        content[idx] = event.toolCall;
        this.toolCallPaths.delete(idx);
        break;
    }
    if (usage) row.message.usage = usage;
    this.emit();
  }

  /**
   * Buffer one argument delta and return the target file read so far. Buffering
   * stops once the path is complete or the scan limit is reached: the complete
   * arguments arrive with toolcall_end, so the card only needs the path early.
   */
  private applyToolCallDelta(idx: number, delta: string): PathScan["path"] {
    let scan = this.toolCallPaths.get(idx);
    if (scan === undefined) {
      scan = { buffer: "", path: null, complete: false };
      this.toolCallPaths.set(idx, scan);
    }
    if (scan.complete || scan.buffer.length >= PATH_SCAN_LIMIT) return scan.path;
    scan.buffer += delta;
    const found = streamedToolPath(scan.buffer);
    if (found !== null) {
      scan.path = { key: found.key, value: found.value };
      scan.complete = found.complete;
    }
    return scan.path;
  }
}
