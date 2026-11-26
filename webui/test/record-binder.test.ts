// Record binder: a run replayed into a fresh page must rebuild the running
// card (start record with args, then live partial output), and a compaction
// must report its running state, not only its end.
import { describe, expect, it } from "vitest";
import { bindRecords, type RunPhase } from "../src/record-binder.ts";
import { SessionStore } from "../src/session-store.ts";
import { ToolStore } from "../src/tool-store.ts";
import { TodoStore } from "../src/todo-store.ts";
import type { WireRecord } from "../src/protocol.ts";

function setup() {
  const session = new SessionStore();
  const tools = new ToolStore();
  const todo = new TodoStore();
  const phases: RunPhase[] = [];
  const compacting: boolean[] = [];
  const bind = bindRecords(session, tools, todo, {
    onRunPhase: (phase) => phases.push(phase),
    onCompacting: (value) => compacting.push(value),
  });
  return { session, tools, todo, bind, phases, compacting };
}

describe("bindRecords", () => {
  it("rebuilds a running tool card from a replayed start and its updates", () => {
    const { tools, bind } = setup();
    bind({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "npm test" } } as WireRecord);
    bind({ type: "tool_execution_update", toolCallId: "c1", partialResult: { content: [{ type: "text", text: "running" }] } } as WireRecord);
    const running = tools.executions.get("c1");
    expect(running?.state).toBe("running");
    expect(running?.args).toEqual({ command: "npm test" });
    expect(running?.partial).toBe("running");
  });

  it("keeps the tool name when only the end record arrives", () => {
    const { tools, bind } = setup();
    // Page reloaded mid-run: the start went out before the socket was there.
    bind({ type: "tool_execution_end", toolCallId: "c2", toolName: "edit", result: { content: [] }, isError: false } as WireRecord);
    expect(tools.executions.get("c2")?.toolName).toBe("edit");
    expect(tools.executions.get("c2")?.state).toBe("done");
  });

  it("reports a compaction as running and finished", () => {
    const { bind, compacting } = setup();
    bind({ type: "compaction_start", reason: "threshold" } as WireRecord);
    bind({ type: "compaction_end", reason: "threshold", aborted: false, willRetry: false } as WireRecord);
    expect(compacting).toEqual([true, false]);
  });

  it("finishes the run only on agent_settled", () => {
    const { bind, phases } = setup();
    bind({ type: "agent_start" } as WireRecord);
    bind({ type: "agent_end" } as WireRecord);
    expect(phases).toEqual(["running"]);
    bind({ type: "agent_settled" } as WireRecord);
    expect(phases).toEqual(["running", "idle"]);
  });
});