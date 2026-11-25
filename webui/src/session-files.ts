// Files the agent changed in this session, grouped by turn (one per user
// message) with the lines each edit added/removed. Derived from the tool store
// so nothing extra has to be wired for hydration after a session switch or a
// page reload.
import { toolPathArg } from "./path-label";
import type { ToolExecution, ToolStore, TurnInfo } from "./tool-store";

/** One file in one turn, with that turn's line counts. */
export type SessionFile = {
  path: string;
  /** Lines added in this turn. */
  added: number;
  /** Lines removed in this turn (writes carry no old text). */
  removed: number;
};

/** One turn's changed files; index 0 holds calls made before any user message. */
export type SessionTurn = TurnInfo & {
  files: SessionFile[];
  added: number;
  removed: number;
};

export type SessionFiles = {
  turns: SessionTurn[];
};

/** Tools that write to a file: pi's edit/write plus edit variants. */
const MUTATING_TOOLS = new Set(["edit", "write", "multi_edit"]);

/** Dedupe key: tools may report the same Windows path in either case. */
function pathKey(path: string): string {
  return path.replaceAll("\\", "/").toLowerCase();
}

/** Line counts of a pi display diff: "+" rows added, "-" rows removed. */
function diffLines(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

/** Line count of file content; a trailing newline does not start a line. */
function contentLines(content: string): number {
  if (content === "") return 0;
  return content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
}

/** Lines one execution contributes; a running edit has no diff yet. */
function execLines(exec: ToolExecution): { added: number; removed: number } {
  if (exec.diff !== undefined) return diffLines(exec.diff);
  // pi's write result carries no diff, so only the written lines are known.
  if (exec.toolName === "write" && typeof exec.args.content === "string") {
    return { added: contentLines(exec.args.content), removed: 0 };
  }
  return { added: 0, removed: 0 };
}

/** Files changed in the session grouped by turn. */
export function sessionFiles(tools: ToolStore): SessionFiles {
  const turns = new Map<number, SessionTurn>();
  const filesByKey = new Map<string, SessionFile>();
  for (const exec of tools.executions.values()) {
    if (!MUTATING_TOOLS.has(exec.toolName)) continue;
    const path = toolPathArg(exec.args);
    if (path === null) continue;
    const { index } = exec.turn;
    let turn = turns.get(index);
    if (turn === undefined) {
      turn = { ...exec.turn, files: [], added: 0, removed: 0 };
      turns.set(index, turn);
    }
    const pkey = pathKey(path);
    let file = filesByKey.get(`${index}:${pkey}`);
    if (file === undefined) {
      file = { path, added: 0, removed: 0 };
      filesByKey.set(`${index}:${pkey}`, file);
      turn.files.push(file);
    }
    const lines = execLines(exec);
    file.added += lines.added;
    file.removed += lines.removed;
    turn.added += lines.added;
    turn.removed += lines.removed;
  }
  return {
    turns: [...turns.values()].sort((a, b) => a.index - b.index),
  };
}