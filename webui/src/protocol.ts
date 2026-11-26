// Protocol types for the pi RPC wire format, per packages/coding-agent/docs:
// rpc-commands.md (commands/responses), json.md (events), message-types.md.
// Only what M1 uses; extend per milestone.

// --- Messages (message-types.md) ---

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  redacted?: boolean;
}

export interface ToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type AssistantContent = TextContent | ThinkingContent | ToolCallContent;

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantContent[];
  api: string;
  provider: string;
  model: string;
  usage: Usage;
  stopReason: StopReason;
  errorMessage?: string;
  timestamp: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  isError: boolean;
  timestamp: number;
}

export interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  timestamp: number;
}

export interface SystemMessage {
  role: "system";
  content: string | TextContent[];
  timestamp: number;
}

export interface CustomMessage {
  role: "custom";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  display: boolean;
  timestamp: number;
}

export interface BranchSummaryMessage {
  role: "branchSummary";
  summary: string;
  timestamp: number;
}

export interface CompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp: number;
}

/** Unknown custom roles are tolerated (message-types.md "AgentMessage union"). */
export type AgentMessage =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage
  | CustomMessage
  | BranchSummaryMessage
  | CompactionSummaryMessage
  | { role: string };

// --- Model (rpc-commands.md "Model object") ---

export interface Model {
  id: string;
  name: string;
  api: string;
  provider: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  maxTokens: number;
}

// --- Events (json.md) ---

export type AssistantMessageEvent =
  | { type: "start" }
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; content: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number; content: string }
  | { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCallContent }
  | { type: "done"; reason: string; message?: unknown }
  | { type: "error"; reason: string; error?: string };

export interface MessageUpdateEvent {
  type: "message_update";
  usage?: Usage;
  assistantMessageEvent: AssistantMessageEvent;
}

export interface ToolExecutionStartEvent {
  type: "tool_execution_start";
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface ToolExecutionUpdateEvent {
  type: "tool_execution_update";
  toolCallId: string;
  toolName: string;
  args?: Record<string, unknown>;
  partialResult: { content: (TextContent | ImageContent)[]; details?: Record<string, unknown> };
}

export interface ToolExecutionEndEvent {
  type: "tool_execution_end";
  toolCallId: string;
  toolName: string;
  result?: { content: (TextContent | ImageContent)[]; details?: Record<string, unknown> };
  isError: boolean;
  durationMs?: number;
}

/** One entry of the todo tool's checklist, as carried in tool result details. */
export interface TodoTask {
  text: string;
  done: boolean;
}

export interface QueueUpdateEvent {
  type: "queue_update";
  steering: string[];
  followUp: string[];
}

// --- Extension UI subprotocol (rpc-extension-ui.md) ---

export type ExtensionUiDialog = {
  type: "extension_ui_request";
  id: string;
  method: "select" | "confirm" | "input" | "editor";
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  timeout?: number;
};

export type ExtensionUiFireForget =
  | { type: "extension_ui_request"; id: string; method: "notify"; message: string; notifyType?: "info" | "warning" | "error" }
  | { type: "extension_ui_request"; id: string; method: "setStatus"; statusKey: string; statusText?: string }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setWidget";
      widgetKey: string;
      widgetLines?: string[];
      widgetPlacement?: "aboveEditor" | "belowEditor";
    }
  | { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
  | { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

export type ExtensionUiRequest = ExtensionUiDialog | ExtensionUiFireForget;

export type ExtensionUiResponse =
  | { type: "extension_ui_response"; id: string; value?: string; confirmed?: boolean; cancelled?: true };

// --- Compaction / retry / misc events ---

export interface CompactionStartEvent {
  type: "compaction_start";
  reason: "manual" | "threshold" | "overflow";
}

export interface CompactionEndEvent {
  type: "compaction_end";
  reason: "manual" | "threshold" | "overflow";
  result?: { summary: string; tokensBefore: number; estimatedTokensAfter: number };
  aborted: boolean;
  willRetry: boolean;
  errorMessage?: string;
}

export interface AutoRetryStartEvent {
  type: "auto_retry_start";
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  errorMessage: string;
}

export interface AutoRetryEndEvent {
  type: "auto_retry_end";
  success: boolean;
  attempt: number;
  finalError?: string;
}

export interface SessionInfoChangedEvent {
  type: "session_info_changed";
  name?: string;
}

export interface ThinkingLevelChangedEvent {
  type: "thinking_level_changed";
  level: string;
}

export interface CommandInfo {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
}

export interface SessionEvent extends Record<string, unknown> {
  type: string;
}

/**
 * One entry of `get_entries` (rpc-commands.md), limited to the fields the UI
 * reads: the append-only session log, which still holds what a compaction
 * summarized away.
 */
export type SessionEntryRecord = {
  type: string;
  id: string;
  parentId: string | null;
  timestamp?: string;
  /** Present on type "message". */
  message?: AgentMessage;
  /** Present on type "compaction": first entry the summary kept. */
  firstKeptEntryId?: string;
};

// --- Records ---

export type ResponseRecord = {
  type: "response";
  command: string;
  success: boolean;
  id?: string;
  data?: unknown;
  error?: string;
};

export type WireRecord =
  | ResponseRecord
  | SessionEvent
  | MessageUpdateEvent
  | ToolExecutionStartEvent
  | ToolExecutionUpdateEvent
  | ToolExecutionEndEvent
  | QueueUpdateEvent
  | CompactionStartEvent
  | CompactionEndEvent
  | AutoRetryStartEvent
  | AutoRetryEndEvent
  | SessionInfoChangedEvent
  | ThinkingLevelChangedEvent
  | ExtensionUiRequest
  | { type: "agent_start" }
  | { type: "agent_end"; willRetry?: boolean }
  | { type: "agent_settled"; aborted: boolean }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_end"; message: AgentMessage }
  | { type: "bridge_lifecycle"; lifecycle: LifecycleType; code?: number | null; message?: string }
  | { type: string; [key: string]: unknown };

// --- Bridge lifecycle records (bridge-owned, not pi protocol) ---

export type LifecycleType = "pi_started" | "pi_exited" | "pi_error";
