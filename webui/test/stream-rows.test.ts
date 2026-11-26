// Which transcript rows are worth a slice slot, and which bash rows duplicate a
// tool card: both decide what "load earlier" counts and what renders twice.
import { describe, expect, it } from "vitest";
import { duplicateBashRows, renderedRows, rendersRow } from "../src/stream-rows.ts";
import type { AgentMessage, BashExecutionMessage } from "../src/protocol.ts";
import type { StreamRow } from "../src/session-store.ts";
import type { ToolExecution } from "../src/tool-store.ts";

let seq = 0;
function row(message: AgentMessage): StreamRow {
  return { kind: "message", message, id: `row-${++seq}` };
}

function bashRow(command: string): StreamRow {
  const message: BashExecutionMessage = {
    role: "bashExecution",
    command,
    output: "",
    exitCode: 0,
    cancelled: false,
    truncated: false,
    timestamp: 1,
  };
  return row(message);
}

function exec(toolCallId: string, toolName: string, args: Record<string, unknown>): ToolExecution {
  return {
    toolCallId,
    toolName,
    args,
    turn: { index: 1, timestamp: 1, preview: "p" },
    state: "done",
    partial: "",
    resultText: "",
    resultImages: [],
    isError: false,
  };
}

const user = { role: "user", content: "hi", timestamp: 1 } as AgentMessage;
const system = { role: "system", content: "tool set changed", timestamp: 1 } as AgentMessage;
const custom = { role: "custom", customType: "x", content: "y", display: true, timestamp: 1 } as AgentMessage;

function toolResult(toolCallId: string, toolName: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [],
    isError: false,
    timestamp: 1,
  } as AgentMessage;
}

describe("rendersRow", () => {
  it("drops system and custom rows, which draw nothing", () => {
    expect(rendersRow(row(system), new Map())).toBe(false);
    expect(rendersRow(row(custom), new Map())).toBe(false);
    expect(rendersRow(row(user), new Map())).toBe(true);
  });

  it("keeps a toolResult row only when no execution card covers it", () => {
    const executions = new Map([["call-1", exec("call-1", "edit", { path: "a.ts" })]]);
    expect(rendersRow(row(toolResult("call-1", "edit")), executions)).toBe(false);
    expect(rendersRow(row(toolResult("call-2", "edit")), executions)).toBe(true);
  });

  it("never renders a read result", () => {
    expect(rendersRow(row(toolResult("call-3", "read")), new Map())).toBe(false);
  });
});

describe("renderedRows", () => {
  it("counts only rows that draw, keeping order", () => {
    const rows = [row(user), row(system), row(toolResult("call-1", "edit")), row(system)];
    const executions = new Map([["call-1", exec("call-1", "edit", {})]]);
    expect(renderedRows(rows, executions).map((r) => r.id)).toEqual([rows[0]!.id]);
  });
});

describe("duplicateBashRows", () => {
  it("hides one row per bash execution with the same command", () => {
    const rows = [bashRow("ls"), bashRow("ls"), bashRow("pwd")];
    const hidden = duplicateBashRows(rows, [exec("c1", "bash", { command: "ls" })]);
    expect([...hidden]).toEqual([rows[0]!.id]);
  });

  it("keeps panel-run rows, which have no execution to pair with", () => {
    const rows = [bashRow("pwd")];
    expect(duplicateBashRows(rows, [exec("c1", "bash", { command: "ls" })]).size).toBe(0);
  });

  it("ignores executions whose args carry no command", () => {
    // Hydrated executions have args restored from the assistant toolCall block;
    // one without them must not swallow an unrelated panel row.
    const rows = [bashRow("pwd")];
    expect(duplicateBashRows(rows, [exec("c1", "bash", {})]).size).toBe(0);
  });

  it("only pairs bash executions", () => {
    const rows = [bashRow("ls")];
    expect(duplicateBashRows(rows, [exec("c1", "edit", { command: "ls" })]).size).toBe(0);
  });
});