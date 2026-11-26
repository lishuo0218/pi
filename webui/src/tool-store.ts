// Tool execution store: live state of tool calls (F-12/F-13/F-14) keyed by
// toolCallId. Reconstructed from tool_execution_* events during a run and
// from toolResult messages on hydration. Also holds the steering/followUp
// queues (F-16) via queue_update.
import type { ImageContent, TextContent, ToolResultMessage } from "./protocol";

export type ToolExecutionState = "running" | "done";

/** Turn a tool call belongs to: one per user message since the session opened. */
export type TurnInfo = {
  /** 1-based; 0 means the call came before any user message in this session. */
  index: number;
  /** User message timestamp (0 for turn 0). */
  timestamp: number;
  /** First line of the user message, truncated (empty for turn 0). */
  preview: string;
};

export type ToolExecution = {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  /** Turn the call was started in; see TurnInfo. */
  turn: TurnInfo;
  state: ToolExecutionState;
  /** Accumulated partial output (bash live tail). */
  partial: string;
  /** Final text result (empty while running). */
  resultText: string;
  resultImages: ImageContent[];
  isError: boolean;
  durationMs?: number;
  /** Edit-style unified diff from result details (F-14), if present. */
  diff?: string;
  /** Bash output truncation counts from result details (F-12 bash card). */
  truncation?: { outputLines: number; totalLines: number };
  /** Temp file holding the full bash output, when pi truncated and saved it. */
  fullOutputPath?: string;
};

/** pi's details.truncation shape (wire input: validated field by field). */
function truncationOf(details: Record<string, unknown> | undefined):
  | { outputLines: number; totalLines: number }
  | undefined {
  const raw = details?.truncation as { outputLines?: unknown; totalLines?: unknown } | undefined;
  if (raw === undefined || typeof raw.outputLines !== "number" || typeof raw.totalLines !== "number") {
    return undefined;
  }
  return { outputLines: raw.outputLines, totalLines: raw.totalLines };
}

function textOf(content: (TextContent | ImageContent)[] | undefined): string {
  if (!content) return "";
  return content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function imagesOf(content: (TextContent | ImageContent)[] | undefined): ImageContent[] {
  if (!content) return [];
  return content.filter((c): c is ImageContent => c.type === "image");
}

export class ToolStore {
  /** Most recent execution per toolCallId; insertion order preserved. */
  executions = new Map<string, ToolExecution>();
  /** Turn current calls belong to; beginTurn replaces it. */
  turn: TurnInfo = { index: 0, timestamp: 0, preview: "" };
  steering: string[] = [];
  followUp: string[] = [];
  /** Queue length reported by get_state when the queue itself is unknown. */
  pendingCount: number | null = null;
  version = 0;
  private subscribers = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  private emit(): void {
    this.version++;
    for (const fn of this.subscribers) fn();
  }

  start(toolCallId: string, toolName: string, args: Record<string, unknown>): void {
    this.executions.set(toolCallId, {
      toolCallId,
      toolName,
      args,
      turn: this.turn,
      state: "running",
      partial: "",
      resultText: "",
      resultImages: [],
      isError: false,
    });
    this.emit();
  }

  update(toolCallId: string, partialResult: { content?: (TextContent | ImageContent)[] }): void {
    const exec = this.executions.get(toolCallId);
    if (!exec) return;
    const text = textOf(partialResult.content);
    if (text) exec.partial = text;
    this.emit();
  }

  end(
    toolCallId: string,
    toolName: string,
    result: { content?: (TextContent | ImageContent)[]; details?: Record<string, unknown> } | undefined,
    isError: boolean,
    durationMs?: number,
  ): void {
    let exec = this.executions.get(toolCallId);
    if (!exec) {
      // end without a seen start (reconnected mid-run, or the start predates a
      // rehydrate that cleared the store): synthesize from the end record,
      // which carries the tool name. The args stay unknown until the assistant
      // message is hydrated.
      exec = {
        toolCallId,
        toolName,
        args: {},
        turn: this.turn,
        state: "running",
        partial: "",
        resultText: "",
        resultImages: [],
        isError: false,
      };
      this.executions.set(toolCallId, exec);
    } else if (exec.turn.index === 0) {
      // Start seen only after a rehydrate reset (reload mid-run): the reset
      // zeroed the turn, but a running call always belongs to the turn it
      // started in, which hydration has restored by now. Rehydrate is
      // generation-guarded, so no other session's turn can land here.
      exec.turn = this.turn;
    }
    exec.toolName = exec.toolName || toolName;
    exec.state = "done";
    exec.resultText = textOf(result?.content) || exec.partial;
    exec.resultImages = imagesOf(result?.content);
    exec.isError = isError;
    exec.durationMs = durationMs;
    const details = result?.details;
    if (details && typeof details.diff === "string") exec.diff = details.diff;
    exec.truncation = truncationOf(details);
    exec.fullOutputPath =
      typeof details?.fullOutputPath === "string" ? details.fullOutputPath : undefined;
    this.emit();
  }

  /**
   * From a toolResult message (get_messages hydration): done execution.
   * `args` come from the assistant message's matching toolCall block; the
   * toolResult message itself does not carry them, but card summaries need
   * the path/command.
   */
  addFromToolResult(
    message: ToolResultMessage,
    args: Record<string, unknown>,
    /** Turn override: pre-compaction history belongs to no user row here. */
    turn?: TurnInfo,
  ): void {
    if (this.executions.has(message.toolCallId)) return;
    const details = (message as unknown as { details?: Record<string, unknown> }).details;
    this.executions.set(message.toolCallId, {
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      args,
      turn: turn ?? this.turn,
      state: "done",
      partial: "",
      resultText: textOf(message.content),
      resultImages: imagesOf(message.content),
      isError: message.isError,
      diff: details && typeof details.diff === "string" ? details.diff : undefined,
      truncation: truncationOf(details),
      fullOutputPath:
        typeof details?.fullOutputPath === "string" ? details.fullOutputPath : undefined,
    });
  }

  /**
   * Open the turn after a user message: tool calls started from now on are
   * grouped under it. Same count on hydration and live, so file grouping
   * survives a session switch or reload.
   */
  beginTurn(timestamp: number, preview: string): void {
    this.turn = { index: this.turn.index + 1, timestamp, preview };
  }

  setQueue(steering: string[], followUp: string[]): void {
    this.steering = steering;
    this.followUp = followUp;
    // The queue itself is now known: it replaces the count get_state reported.
    this.pendingCount = null;
    this.emit();
  }

  /** Queue length from get_state: the items themselves are pi-internal. */
  setPendingCount(count: number | null): void {
    this.pendingCount = count;
    this.emit();
  }

  /**
   * Rewind the per-turn derivation before a snapshot is applied (hydration can
   * run twice: a second get_messages after a mid-flight message_end). Keeps the
   * live queue, which the snapshot does not carry.
   */
  beginHydrate(): void {
    this.executions.clear();
    this.turn = { index: 0, timestamp: 0, preview: "" };
    this.emit();
  }

  clear(): void {
    this.beginHydrate();
    this.steering = [];
    this.followUp = [];
    this.pendingCount = null;
    this.emit();
  }
}
