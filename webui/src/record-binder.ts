// Bind wire records to stores: run state (F-05), streaming reconstruction
// (F-03), tool executions (F-12~14), queues (F-16), compaction/retry
// notices (F-25/F-26), session info changes. Completion signal is
// agent_settled only (PRD: agent_end 不等于完成). Also feeds the todo
// side panel from todo tool result details.
import type { AgentMessage, AssistantMessage, ToolResultMessage, UserMessage, WireRecord } from "./protocol";
import type { SessionStore } from "./session-store";
import type { ToolStore } from "./tool-store";
import type { TodoStore } from "./todo-store";
import { turnPreview } from "./turn-preview";

export type Disposition = "started" | "queued" | "handled";

export type RunPhase = "idle" | "running" | "stopping";

export type RetryInfo = { attempt: number; maxAttempts: number; errorMessage: string };

export type BindHandlers = {
  onDisposition?: (disposition: Disposition) => void;
  onRunPhase?: (phase: RunPhase) => void;
  onUiRequest?: (record: WireRecord) => void;
  onToast?: (text: string, err?: boolean) => void;
  onRetry?: (info: RetryInfo | null) => void;
  onCompactionEnd?: () => void;
  /** A compaction is running (started or finished, aborted and failed included). */
  onCompacting?: (compacting: boolean) => void;
};

export function bindRecords(
  session: SessionStore,
  tools: ToolStore,
  todo: TodoStore,
  handlers: BindHandlers,
) {
  return (record: WireRecord): void => {
    switch (record.type) {
      case "agent_start": {
        session.setState({ isStreaming: true });
        handlers.onRunPhase?.("running");
        // One checklist per task: a new turn starts empty, and the agent fills
        // it with a fresh `todo set`. Keeps a finished task's list from looking
        // like the current one.
        todo.clear();
        break;
      }
      case "agent_settled": {
        session.setState({ isStreaming: false });
        handlers.onRunPhase?.("idle");
        handlers.onRetry?.(null);
        break;
      }
      case "session_info_changed": {
        const ev = record as Extract<WireRecord, { type: "session_info_changed" }>;
        session.setState({ sessionName: ev.name ?? null });
        break;
      }
      case "thinking_level_changed": {
        const ev = record as Extract<WireRecord, { type: "thinking_level_changed" }>;
        session.setState({ thinkingLevel: ev.level });
        break;
      }
      case "compaction_start": {
        const ev = record as Extract<WireRecord, { type: "compaction_start" }>;
        handlers.onCompacting?.(true);
        handlers.onToast?.(`正在压缩上下文（${ev.reason === "manual" ? "手动" : ev.reason === "threshold" ? "阈值" : "溢出恢复"}）`);
        break;
      }
      case "compaction_end": {
        const ev = record as Extract<WireRecord, { type: "compaction_end" }>;
        handlers.onCompacting?.(false);
        if (ev.aborted) handlers.onToast?.("压缩已中止", true);
        else if (ev.errorMessage) handlers.onToast?.(`压缩失败：${ev.errorMessage}`, true);
        else if (ev.result) {
          handlers.onToast?.(
            `压缩完成：${ev.result.tokensBefore} → ~${ev.result.estimatedTokensAfter} tokens`,
          );
          handlers.onCompactionEnd?.();
        }
        break;
      }
      case "auto_retry_start": {
        const ev = record as Extract<WireRecord, { type: "auto_retry_start" }>;
        handlers.onRetry?.({
          attempt: ev.attempt,
          maxAttempts: ev.maxAttempts,
          errorMessage: ev.errorMessage,
        });
        break;
      }
      case "auto_retry_end": {
        const ev = record as Extract<WireRecord, { type: "auto_retry_end" }>;
        handlers.onRetry?.(null);
        if (!ev.success) handlers.onToast?.(`重试失败：${ev.finalError ?? "未知错误"}`, true);
        else handlers.onToast?.(`第 ${ev.attempt} 次重试成功`);
        break;
      }
      case "extension_ui_request": {
        handlers.onUiRequest?.(record);
        break;
      }
      case "message_start": {
        const message = record.message as AgentMessage | undefined;
        const role = message && (message as { role?: string }).role;
        if (message && role === "assistant") {
          session.startStreaming(message as AssistantMessage);
        } else if (message) {
          // A user message opens a turn; the side panel groups file edits
          // under it. Hydration counts the same messages, so both agree.
          if (role === "user") {
            const user = message as UserMessage;
            tools.beginTurn(user.timestamp, turnPreview(user.content));
          }
          session.appendMessage(message);
        }
        break;
      }
      case "message_update": {
        const update = record as Extract<WireRecord, { type: "message_update" }>;
        session.applyAssistantEvent(
          update.assistantMessageEvent as Parameters<SessionStore["applyAssistantEvent"]>[0],
          update.usage,
        );
        break;
      }
      case "message_end": {
        const message = record.message as AgentMessage | undefined;
        // Non-assistant roles already arrived via message_start; their
        // message_end is a duplicate (pi emits both; the TUI skips user too).
        const role = message && (message as { role?: string }).role;
        if (message && role === "assistant") session.finishStreaming(message);
        break;
      }
      case "tool_execution_start": {
        const ev = record as Extract<WireRecord, { type: "tool_execution_start" }>;
        tools.start(ev.toolCallId, ev.toolName, ev.args ?? {});
        break;
      }
      case "tool_execution_update": {
        const ev = record as Extract<WireRecord, { type: "tool_execution_update" }>;
        tools.update(ev.toolCallId, ev.partialResult ?? {});
        break;
      }
      case "tool_execution_end": {
        const ev = record as Extract<WireRecord, { type: "tool_execution_end" }>;
        tools.end(ev.toolCallId, ev.toolName, ev.result, ev.isError, ev.durationMs);
        if (ev.toolName === "todo") todo.setFromDetails(ev.result?.details);
        break;
      }
      case "queue_update": {
        const ev = record as Extract<WireRecord, { type: "queue_update" }>;
        tools.setQueue(ev.steering ?? [], ev.followUp ?? []);
        break;
      }
      case "todo_state": {
        // Bridge replay of the current checklist for a client that attached
        // mid-session; authoritative over what get_messages still carries.
        const ev = record as { details?: Record<string, unknown> };
        todo.setFromDetails(ev.details);
        break;
      }
      case "response": {
        // steer/follow_up responses carry disposition too (rpc-commands.md).
        const command = record.command;
        if ((command === "prompt" || command === "steer" || command === "follow_up") && record.success) {
          const data = record.data as { disposition?: Disposition } | undefined;
          if (data?.disposition) handlers.onDisposition?.(data.disposition);
        }
        break;
      }
    }
  };
}
