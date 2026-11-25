// Patch parsing for the Git diff pane. A unified patch becomes rows that carry
// the line numbers the gutter shows, each hunk keeps the index that hunk-level
// stage/discard names, and a long run of unchanged context folds into one
// expandable row (the page asks for full context when the user wants gaps).
export type DiffRow =
  | { kind: "meta"; text: string }
  | { kind: "hunk"; text: string; hunk: number }
  | { kind: "ctx"; text: string; old: number; new: number; hunk: number }
  | { kind: "add"; text: string; new: number; hunk: number }
  | { kind: "del"; text: string; old: number; hunk: number }
  | { kind: "note"; text: string };

/** One rendered line: a patch row, or a collapsed run of unchanged context. */
export type DisplayRow =
  | { kind: "row"; row: DiffRow }
  | { kind: "fold"; id: number; count: number };

export type SearchHit = { row: number; start: number; length: number };

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
/** Runs of context longer than this fold; shorter ones stay inline. */
const FOLD_MIN = 10;
/** Context lines kept visible at each end of a folded run. */
const FOLD_KEEP = 3;

/** Parse a unified patch (git diff / git show) into numbered rows. */
export function parsePatch(text: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let hunk = -1;
  let inHunk = false;
  let old = 0;
  let next = 0;
  for (const line of text.split("\n")) {
    if (line === "") continue;
    // A new file in a multi-file patch ends the previous file's hunk.
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      rows.push({ kind: "meta", text: line });
      continue;
    }
    const header = HUNK_HEADER.exec(line);
    if (header !== null) {
      hunk += 1;
      inHunk = true;
      old = Number(header[1]);
      next = Number(header[2]);
      rows.push({ kind: "hunk", text: line, hunk });
      continue;
    }
    if (!inHunk) {
      rows.push({ kind: "meta", text: line });
      continue;
    }
    const marker = line[0];
    const body = line.slice(1);
    if (marker === "\\") rows.push({ kind: "note", text: line });
    else if (marker === " ") rows.push({ kind: "ctx", text: body, old: old++, new: next++, hunk });
    else if (marker === "+") rows.push({ kind: "add", text: body, new: next++, hunk });
    else if (marker === "-") rows.push({ kind: "del", text: body, old: old++, hunk });
    else rows.push({ kind: "meta", text: line });
  }
  return rows;
}

/**
 * Fold long context runs. `expanded` holds the fold ids to keep open; "all"
 * opens everything (a search jump into a hidden row needs that).
 */
export function buildDisplay(rows: DiffRow[], expanded: ReadonlySet<number> | "all"): DisplayRow[] {
  const display: DisplayRow[] = [];
  let foldId = 0;
  let index = 0;
  while (index < rows.length) {
    const row = rows[index];
    if (row === undefined) break;
    if (row.kind !== "ctx") {
      display.push({ kind: "row", row });
      index += 1;
      continue;
    }
    let end = index;
    while (end < rows.length && rows[end]?.kind === "ctx") end += 1;
    const id = foldId++;
    const count = end - index;
    if (count > FOLD_MIN && expanded !== "all" && !expanded.has(id)) {
      const head = Math.min(FOLD_KEEP, count);
      for (let i = index; i < index + head; i++) {
        const kept = rows[i];
        if (kept !== undefined) display.push({ kind: "row", row: kept });
      }
      display.push({ kind: "fold", id, count: count - head * 2 });
      for (let i = end - head; i < end; i++) {
        const kept = rows[i];
        if (kept !== undefined) display.push({ kind: "row", row: kept });
      }
    } else {
      for (let i = index; i < end; i++) {
        const kept = rows[i];
        if (kept !== undefined) display.push({ kind: "row", row: kept });
      }
    }
    index = end;
  }
  return display;
}

/** Row indices of `query` matches inside patch content, in patch order. */
export function findHits(
  rows: DiffRow[],
  query: string,
  opts: { caseSensitive: boolean; regex: boolean },
): SearchHit[] {
  if (query === "") return [];
  let pattern: RegExp;
  try {
    pattern = new RegExp(opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), opts.caseSensitive ? "g" : "gi");
  } catch {
    return [];
  }
  const hits: SearchHit[] = [];
  for (let row = 0; row < rows.length; row++) {
    const entry = rows[row];
    if (entry === undefined) continue;
    if (entry.kind !== "ctx" && entry.kind !== "add" && entry.kind !== "del") continue;
    pattern.lastIndex = 0;
    let match = pattern.exec(entry.text);
    while (match !== null && match[0] !== "") {
      hits.push({ row, start: match.index, length: match[0].length });
      match = pattern.exec(entry.text);
    }
  }
  return hits;
}

/** Display index showing patch row `row`, or -1 when a fold hides it. */
export function displayIndexOf(display: DisplayRow[], row: number): number {
  // Rows keep patch order, so walk the display list counting patch rows.
  let seen = 0;
  for (let index = 0; index < display.length; index++) {
    const entry = display[index];
    if (entry === undefined) continue;
    if (entry.kind === "fold") continue;
    if (seen === row) return index;
    seen += 1;
  }
  return -1;
}