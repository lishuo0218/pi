// Which transcript rows actually render, and which bash rows duplicate a tool
// card. The "load earlier" slice and its count must only count rows that draw
// something: a hydrated session carries one toolResult row and one system row
// per tool call, and both render nothing.
import type { BashExecutionMessage, ToolResultMessage } from "./protocol";
import type { StreamRow } from "./session-store";
import type { ToolExecution } from "./tool-store";

/** Rows that draw nothing at all, in any state. */
function neverRenders(row: StreamRow): boolean {
  if (row.kind === "streaming") return false;
  return row.message.role === "system" || row.message.role === "custom";
}

/**
 * Rows this store state renders. A toolResult row is the fallback card for a
 * result whose execution the store does not have (a tool run the bridge could
 * not replay, or pre-compaction history); `read` never renders either.
 */
export function rendersRow(row: StreamRow, executions: Map<string, ToolExecution>): boolean {
  if (neverRenders(row)) return false;
  if (row.kind !== "message" || row.message.role !== "toolResult") return true;
  const result = row.message as ToolResultMessage;
  if (result.toolName === "read") return false;
  return !executions.has(result.toolCallId);
}

/** The rows of the transcript that draw something, in order. */
export function renderedRows(rows: StreamRow[], executions: Map<string, ToolExecution>): StreamRow[] {
  return rows.filter((row) => rendersRow(row, executions));
}

/**
 * Bash transcript rows that repeat a bash tool card, matched by command text
 * rather than position: hydrated rows, replayed rows and panel-run rows arrive
 * in no guaranteed order, and pi writes a bashExecution row for tool runs too.
 * Each execution hides at most one row (so a command run twice hides two
 * rows), and a row with no execution left is a panel run and stays visible.
 */
export function duplicateBashRows(rows: StreamRow[], executions: ToolExecution[]): Set<string> {
  const remaining = new Map<string, number>();
  for (const exec of executions) {
    if (exec.toolName !== "bash") continue;
    const command = exec.args.command;
    if (typeof command !== "string" || command === "") continue;
    remaining.set(command, (remaining.get(command) ?? 0) + 1);
  }
  const hidden = new Set<string>();
  for (const row of rows) {
    if (row.kind !== "message" || row.message.role !== "bashExecution") continue;
    const command = (row.message as BashExecutionMessage).command;
    const left = remaining.get(command) ?? 0;
    if (left === 0) continue;
    remaining.set(command, left - 1);
    hidden.add(row.id);
  }
  return hidden;
}