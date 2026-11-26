// Streaming reconstruction of tool calls: the argument deltas must fill in the
// card's target file before the call completes, so the edit card can name the
// file it is about to change (json.md "Reconstruct streaming messages").
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionStore } from "../src/session-store.ts";
import type { AssistantMessage, ToolCallContent } from "../src/protocol.ts";

function emptyAssistant(): AssistantMessage {
  return {
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
    timestamp: 1,
  };
}

/** Arguments of the streaming row's tool-call block `index`. */
function streamedArgs(store: SessionStore, index = 0): Record<string, unknown> {
  const row = store.rows[0];
  if (row?.kind !== "streaming") throw new Error("expected a streaming row");
  const block = row.message.content[index];
  if (block?.type !== "toolCall") throw new Error("expected a toolCall block");
  return block.arguments;
}

describe("SessionStore tool-call deltas", () => {
  // Argument updates are frame-throttled, so tests step the clock instead of
  // sleeping; Date is the only clock the store reads.
  let clock = 0;
  const tick = (ms: number): void => {
    clock += ms;
    vi.setSystemTime(clock);
  };
  beforeEach(() => {
    clock = 1_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(clock);
  });
  afterEach(() => vi.useRealTimers());

  it("fills in the target file while the arguments stream", () => {
    const store = new SessionStore();
    store.startStreaming(emptyAssistant());
    store.applyAssistantEvent({ type: "toolcall_start", contentIndex: 0, id: "c1", toolName: "edit" });
    expect(streamedArgs(store)).toEqual({});

    store.applyAssistantEvent({
      type: "toolcall_delta",
      contentIndex: 0,
      delta: '{"path":"src/edi',
    });
    expect(streamedArgs(store)).toEqual({ path: "src/edi" });

    tick(80);
    store.applyAssistantEvent({
      type: "toolcall_delta",
      contentIndex: 0,
      delta: 't-card.tsx","edits":[{"oldText":"a","newText":"b"}]}',
    });
    // Only the target file streams in; the full arguments arrive with the end.
    expect(streamedArgs(store)).toEqual({ path: "src/edit-card.tsx" });

    const toolCall: ToolCallContent = {
      type: "toolCall",
      id: "c1",
      name: "edit",
      arguments: { path: "src/edit-card.tsx", edits: [{ oldText: "a", newText: "b" }] },
    };
    store.applyAssistantEvent({ type: "toolcall_end", contentIndex: 0, toolCall });
    expect(streamedArgs(store)).toEqual(toolCall.arguments);
  });

  it("shows the written content growing while the arguments stream", () => {
    const store = new SessionStore();
    store.startStreaming(emptyAssistant());
    store.applyAssistantEvent({ type: "toolcall_start", contentIndex: 0, id: "c1", toolName: "write" });
    store.applyAssistantEvent({
      type: "toolcall_delta",
      contentIndex: 0,
      delta: '{"content":"export const a = 1;\\n',
    });
    expect(streamedArgs(store)).toEqual({ content: "export const a = 1;\n" });

    tick(80);
    store.applyAssistantEvent({ type: "toolcall_delta", contentIndex: 0, delta: '","path":"src/a.ts"' });
    expect(streamedArgs(store)).toEqual({ content: "export const a = 1;\n", path: "src/a.ts" });
  });

  it("coalesces argument updates within one frame", () => {
    const store = new SessionStore();
    store.startStreaming(emptyAssistant());
    store.applyAssistantEvent({ type: "toolcall_start", contentIndex: 0, id: "c1", toolName: "write" });
    store.applyAssistantEvent({ type: "toolcall_delta", contentIndex: 0, delta: '{"path":"a.ts"' });
    expect(streamedArgs(store)).toEqual({ path: "a.ts" });

    // Same frame: the card does not see this fragment yet.
    store.applyAssistantEvent({ type: "toolcall_delta", contentIndex: 0, delta: ',"content":"x"' });
    expect(streamedArgs(store)).toEqual({ path: "a.ts" });

    // Next frame reads the whole buffer, so the dropped fragment is not lost.
    tick(80);
    store.applyAssistantEvent({ type: "toolcall_delta", contentIndex: 0, delta: ',"overwrite":true}' });
    expect(streamedArgs(store)).toEqual({ path: "a.ts", content: "x" });
  });

  it("gives the next tool call of the same message its own frame", () => {
    const store = new SessionStore();
    store.startStreaming(emptyAssistant());
    store.applyAssistantEvent({ type: "toolcall_start", contentIndex: 0, id: "c1", toolName: "write" });
    store.applyAssistantEvent({ type: "toolcall_delta", contentIndex: 0, delta: '{"path":"a.ts"' });

    store.applyAssistantEvent({ type: "toolcall_start", contentIndex: 1, id: "c2", toolName: "write" });
    store.applyAssistantEvent({ type: "toolcall_delta", contentIndex: 1, delta: '{"path":"b.ts"' });
    expect(streamedArgs(store, 1)).toEqual({ path: "b.ts" });
  });

  it("publishes the complete arguments at the end of the call", () => {
    const store = new SessionStore();
    store.startStreaming(emptyAssistant());
    store.applyAssistantEvent({ type: "toolcall_start", contentIndex: 0, id: "c1", toolName: "write" });
    store.applyAssistantEvent({ type: "toolcall_delta", contentIndex: 0, delta: '{"path":"a.ts"' });
    // Still inside the frame: the truncated path is what the card shows.
    store.applyAssistantEvent({ type: "toolcall_delta", contentIndex: 0, delta: ',"content":"x"}' });
    expect(streamedArgs(store)).toEqual({ path: "a.ts" });

    const toolCall: ToolCallContent = {
      type: "toolCall",
      id: "c1",
      name: "write",
      arguments: { path: "a.ts", content: "x" },
    };
    store.applyAssistantEvent({ type: "toolcall_end", contentIndex: 0, toolCall });
    expect(streamedArgs(store)).toEqual({ path: "a.ts", content: "x" });
  });

  it("drops buffered deltas when a replayed stream restarts the message", () => {
    const store = new SessionStore();
    store.startStreaming(emptyAssistant());
    store.applyAssistantEvent({ type: "toolcall_start", contentIndex: 0, id: "c1", toolName: "edit" });
    store.applyAssistantEvent({ type: "toolcall_delta", contentIndex: 0, delta: '{"path":"old.ts"' });

    store.startStreaming(emptyAssistant());
    store.applyAssistantEvent({ type: "toolcall_start", contentIndex: 0, id: "c1", toolName: "edit" });
    store.applyAssistantEvent({ type: "toolcall_delta", contentIndex: 0, delta: '{"path":"new.ts"' });
    expect(streamedArgs(store)).toEqual({ path: "new.ts" });
  });
});