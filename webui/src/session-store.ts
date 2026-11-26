// Session store: authoritative message list + streaming reconstruction per
// json.md "Reconstruct streaming messages". message_end replaces wholesale.
import type {
  AgentMessage,
  AssistantContent,
  AssistantMessage,
  ToolCallContent,
  Usage,
} from "./protocol";
import { readStreamedArgs } from "./tool-args-stream";

/**
 * How often the streaming arguments are re-read for the card. The argument JSON
 * is decoded from the start on every read (an incomplete string has no cheaper
 * way to unescape), so a fast write stream would otherwise re-decode a growing
 * buffer per delta. The card only needs a fresh content every few frames, and
 * toolcall_end publishes the authoritative arguments anyway.
 */
const ARGS_FRAME_MS = 80;

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

export class SessionStore {
  rows: StreamRow[] = [];
  /** Streamed argument JSON per tool-call block, for `toolcall_delta`. */
  private toolCallArgs = new Map<number, { raw: string; at: number }>();
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
    this.toolCallArgs.clear();
    this.emit();
  }

  /** Hydrate from get_messages + get_state (F-01). */
  hydrate(messages: AgentMessage[], state: AgentState): void {
    this.noteSession(state.sessionFile);
    this.rows = messages.map((message) => ({ kind: "message", message, id: nextRowId() }));
    this.earlier = [];
    this.toolCallArgs.clear();
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
    this.toolCallArgs.clear();
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
    this.toolCallArgs.clear();
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
        this.toolCallArgs.delete(idx);
        break;
      case "toolcall_delta": {
        // Wire input: `delta` is a fragment of the block's argument JSON. The
        // card shows the path from the first fragment and the written content
        // while it is still arriving.
        const call = block as ToolCallContent;
        const scan = this.toolCallArgs.get(idx) ?? { raw: "", at: 0 };
        this.toolCallArgs.set(idx, scan);
        scan.raw += event.delta;
        const now = Date.now();
        if (now - scan.at < ARGS_FRAME_MS) return;
        scan.at = now;
        const args = readStreamedArgs(scan.raw);
        const streamed: Record<string, unknown> = {};
        if (args.path !== null) streamed[args.path.key] = args.path.value;
        if (args.content !== null) streamed.content = args.content;
        content[idx] = { type: "toolCall", id: call.id, name: call.name, arguments: streamed };
        break;
      }
      case "toolcall_end":
        content[idx] = event.toolCall;
        this.toolCallArgs.delete(idx);
        break;
    }
    if (usage) row.message.usage = usage;
    this.emit();
  }

}
