// Message rendering: user text + images, assistant markdown body with role
// row / thinking collapse / usage, inline tool cards from the tool store.
import { useEffect, useRef, useState } from "preact/hooks";
import { useSyncExternalStore } from "preact/compat";
import type { JSX } from "preact";
import type {
  AgentMessage,
  AssistantMessage,
  BashExecutionMessage,
  ImageContent,
  ThinkingContent,
  TextContent,
  ToolCallContent,
  ToolResultMessage,
  UserMessage,
} from "./protocol";
import { IconThinking } from "./icons";
import { renderMarkdown } from "./markdown";
import { ToolCard } from "./tool-card";
import { BashCard, bashRunFromMessage } from "./bash-card";
import type { ToolStore } from "./tool-store";

export function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function formatUsage(usage: AssistantMessage["usage"]): string {
  const fmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const cost = usage.cost?.total != null ? ` · $${usage.cost.total.toFixed(4)}` : "";
  return `↑${fmt(usage.input)} ↓${fmt(usage.output)}${cost}`;
}

/** Concatenated text of a user/assistant content value. */
export function textOf(content: string | (TextContent | ImageContent)[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("");
}

function imagesOf(content: string | (TextContent | ImageContent)[]): ImageContent[] {
  if (typeof content === "string") return [];
  return content.filter((c): c is ImageContent => c.type === "image");
}

function ImageView({ img }: { img: ImageContent }): JSX.Element {
  return (
    <img class="user-image" src={`data:${img.mimeType};base64,${img.data}`} alt="附件图片" />
  );
}

export function ThinkingBlock({
  content,
  live,
}: {
  content: ThinkingContent;
  /** This block is still receiving thinking deltas: it opens on its own and follows its tail. */
  live: boolean;
}): JSX.Element {
  // A click overrides the automatic behaviour for the rest of this block's life, i.e. until the row unmounts.
  const [manual, setManual] = useState<boolean | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const open = manual ?? live;
  useEffect(() => {
    const body = bodyRef.current;
    if (body && live && open) body.scrollTop = body.scrollHeight;
  }, [content.thinking, live, open]);
  if (!content.thinking) return <div />;
  return (
    <div class={`thinking${open ? " open" : ""}${live ? " live" : ""}`}>
      <div class="summary" onClick={() => setManual(!open)}>
        <IconThinking />
        {live ? "思考中…" : "已思考"}
      </div>
      <div class="body md-body" ref={bodyRef} dangerouslySetInnerHTML={{ __html: renderMarkdown(content.thinking) }} />
    </div>
  );
}

function AssistantBlock({
  message,
  toolStore,
  atTurnEnd,
}: {
  message: AssistantMessage;
  toolStore: ToolStore;
  /** Last assistant message of its turn: shows the time and token footer. */
  atTurnEnd: boolean;
}): JSX.Element {
  useSyncExternalStore(
    (cb) => toolStore.subscribe(cb),
    () => toolStore.version,
  );
  const streaming = message.stopReason === "pending";
  const hasText = message.content.some(
    (c) => c.type === "text" && (c as TextContent).text,
  );
  return (
    <div class="msg-assistant narrow">
      {message.content.map((c, i) => {
        if (c.type === "thinking")
          return (
            <ThinkingBlock
              key={i}
              content={c as ThinkingContent}
              live={streaming && i === message.content.length - 1}
            />
          );
        if (c.type === "toolCall") {
          const call = c as ToolCallContent;
          const exec = toolStore.executions.get(call.id);
          if (exec) return <ToolCard key={i} exec={exec} />;
          // Still streaming (or the run has not reached tool_execution_start
          // yet): build the card from the call itself, so the target file shows
          // from the first argument delta and the edit preview starts as soon
          // as the arguments are complete, not when the tool ends.
          if (streaming) {
            return (
              <ToolCard
                key={i}
                exec={{
                  toolCallId: call.id,
                  toolName: call.name,
                  args: call.arguments,
                  turn: toolStore.turn,
                  state: "running",
                  partial: "",
                  resultText: "",
                  resultImages: [],
                  isError: false,
                }}
              />
            );
          }
          // No execution seen (call only, aborted run): render a call-only stub.
          return (
            <div key={i} class="tool-card done">
              <div class="tool-head">
                <span class="tool-name">{call.name}</span>
              </div>
            </div>
          );
        }
        const text = (c as TextContent).text;
        if (!text) return null;
        return <div key={i} class="md-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
      })}
      {!hasText && streaming ? (
        <div class="running-line">
          <span class="spinner" />
          运行中…
        </div>
      ) : null}
      {message.stopReason === "error" && message.errorMessage ? (
        <div class="error-line">{message.errorMessage}</div>
      ) : null}
      {!streaming && atTurnEnd ? (
        <div class="turn-meta">{turnMeta(message)}</div>
      ) : null}
    </div>
  );
}

/** `15:54 · ↑1.2k ↓340 · $0.0123` for the end of a finished turn. */
function turnMeta(message: AssistantMessage): string {
  const parts: string[] = [];
  if (message.timestamp) parts.push(formatTime(message.timestamp));
  if (message.usage) parts.push(formatUsage(message.usage));
  return parts.join(" · ");
}

/** A toolResult transcript row: card if the store lacks the execution (hydration). */
function ToolResultBlock({
  message,
  toolStore,
}: {
  message: ToolResultMessage;
  toolStore: ToolStore;
}): JSX.Element | null {
  useSyncExternalStore(
    (cb) => toolStore.subscribe(cb),
    () => toolStore.version,
  );
  // Live runs render via the assistant's inline toolCall card already.
  if (toolStore.executions.has(message.toolCallId)) return null;
  const details = (message as unknown as { details?: Record<string, unknown> }).details;
  const exec = {
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    args: {},
    // Display-only stand-in for a transcript row; no turn attribution needed.
    turn: { index: 0, timestamp: 0, preview: "" },
    state: "done" as const,
    partial: "",
    resultText: textOf(message.content),
    resultImages: imagesOf(message.content),
    isError: message.isError,
    diff: details && typeof details.diff === "string" ? details.diff : undefined,
  };
  return <ToolCard exec={exec} />;
}

export function MessageView({
  message,
  toolStore,
  hideBash,
  onFork,
  forkOccurrence,
  atTurnEnd,
}: {
  message: AgentMessage;
  toolStore: ToolStore;
  /** Set by MessagesArea: this bashExecution row is a duplicate of a tool card. */
  hideBash: boolean;
  onFork?: (text: string, occurrence: number) => void;
  /** nth occurrence (0-based) of this user message's text, for exact fork targeting. */
  forkOccurrence?: number;
  /** Set by MessagesArea: last assistant row before the next user message. */
  atTurnEnd?: boolean;
}): JSX.Element | null {
  switch (message.role) {
    case "user": {
      const user = message as UserMessage;
      const imgs = imagesOf(user.content);
      const text = textOf(user.content);
      return (
        <div class="msg-user-row">
          <div class="msg-user">
            {text}
            {imgs.map((img, i) => (
              <ImageView key={i} img={img} />
            ))}
          </div>
          {onFork && text ? (
            <button
              class="fork-btn"
              title="从此消息分叉新分支"
              onClick={() => onFork(text, forkOccurrence ?? 0)}
            >
              ⤷ 分叉
            </button>
          ) : null}
        </div>
      );
    }
    case "assistant":
      return (
        <AssistantBlock
          message={message as AssistantMessage}
          toolStore={toolStore}
          atTurnEnd={atTurnEnd ?? false}
        />
      );
    case "toolResult":
      return <ToolResultBlock message={message as ToolResultMessage} toolStore={toolStore} />;
    case "system":
    case "branchSummary":
    case "compactionSummary":
      return null;
    case "bashExecution": {
      const bash = message as BashExecutionMessage;
      // The duplicate of a bash tool run's ToolCard is paired and hidden by
      // MessagesArea; anything not paired (e.g. panel-run bash, which has no
      // tool execution) renders here. Same card either way.
      if (hideBash) return null;
      return (
        <div class="msg-assistant narrow">
          <BashCard run={bashRunFromMessage(bash)} behavior={{ kind: "stream" }} />
        </div>
      );
    }
    case "custom":
      return null;
    default:
      return null;
  }
}
