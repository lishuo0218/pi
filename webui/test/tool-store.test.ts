// Tool store: a result whose start was never seen must keep the tool name it
// came with, hydration rewinds turns without losing the queue, and the queue
// count from get_state is a fallback only until the queue itself is known.
import { describe, expect, it } from "vitest";
import { ToolStore } from "../src/tool-store.ts";
import type { ToolResultMessage } from "../src/protocol.ts";

function result(toolCallId: string, toolName: string, text = "ok"): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 1,
  } as ToolResultMessage;
}

describe("ToolStore.end", () => {
  it("keeps the tool name of an end whose start was never seen", () => {
    const tools = new ToolStore();
    tools.start("call-1", "edit", { path: "a.ts" });
    // A rehydrate cleared the store between start and end.
    tools.clear();
    tools.end("call-1", "edit", { content: [{ type: "text", text: "done" }] }, false);
    const exec = tools.executions.get("call-1");
    expect(exec?.toolName).toBe("edit");
    expect(exec?.state).toBe("done");
    expect(exec?.resultText).toBe("done");
  });

  it("attributes a start that landed after a rehydrate reset to the current turn", () => {
    const tools = new ToolStore();
    tools.beginTurn(1, "first");
    tools.beginHydrate();
    tools.end("call-2", "bash", undefined, false);
    // The reset zeroed the counter; hydration restored turn 1 by then.
    expect(tools.executions.get("call-2")?.turn.index).toBe(0);
  });
});

describe("ToolStore queue state", () => {
  it("hydrates a toolResult under the turn given by the caller", () => {
    const tools = new ToolStore();
    tools.beginTurn(1, "first");
    tools.addFromToolResult(result("c1", "edit"), { path: "a.ts" });
    expect(tools.executions.get("c1")?.turn.index).toBe(1);
    tools.addFromToolResult(result("c2", "edit"), { path: "b.ts" }, { index: 0, timestamp: 0, preview: "" });
    expect(tools.executions.get("c2")?.turn.index).toBe(0);
  });

  it("uses the get_state count until a queue update arrives", () => {
    const tools = new ToolStore();
    tools.setPendingCount(2);
    expect(tools.pendingCount).toBe(2);
    tools.setQueue(["steer"], []);
    expect(tools.pendingCount).toBeNull();
    expect(tools.steering).toEqual(["steer"]);
  });

  it("keeps the queue across a rehydrate rewind", () => {
    const tools = new ToolStore();
    tools.setQueue(["steer"], ["later"]);
    tools.beginHydrate();
    expect(tools.steering).toEqual(["steer"]);
    expect(tools.followUp).toEqual(["later"]);
    tools.clear();
    expect(tools.steering).toEqual([]);
    expect(tools.followUp).toEqual([]);
  });
});