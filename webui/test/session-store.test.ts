// Streaming reconstruction of tool calls: the argument deltas must fill in the
// card's target file before the call completes, so the edit card can name the
// file it is about to change (json.md "Reconstruct streaming messages").
import { describe, expect, it } from "vitest";
import { SessionStore, streamedToolPath } from "../src/session-store.ts";
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

/** Arguments of the streaming row's tool-call block 0. */
function streamedArgs(store: SessionStore): Record<string, unknown> {
  const row = store.rows[0];
  if (row?.kind !== "streaming") throw new Error("expected a streaming row");
  const block = row.message.content[0];
  if (block?.type !== "toolCall") throw new Error("expected a toolCall block");
  return block.arguments;
}

describe("streamedToolPath", () => {
  it("reads the target out of a complete argument object", () => {
    expect(streamedToolPath('{"path":"a.ts","edits":[{"oldText":"x","newText":"y"}]}')).toEqual({
      key: "path",
      value: "a.ts",
      complete: true,
    });
  });

  it("decodes an escaped Windows path while it is still streaming", () => {
    expect(streamedToolPath('{"path":"D:\\\\downl')).toEqual({
      key: "path",
      value: "D:\\downl",
      complete: false,
    });
  });

  it("accepts the argument names of the older tools", () => {
    expect(streamedToolPath('{"file_path":"src/a.ts"')).toEqual({
      key: "file_path",
      value: "src/a.ts",
      complete: true,
    });
  });

  it("returns nothing before a path key has arrived", () => {
    expect(streamedToolPath('{"edits":[{"oldTe')).toBeNull();
  });
});

describe("SessionStore tool-call deltas", () => {
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