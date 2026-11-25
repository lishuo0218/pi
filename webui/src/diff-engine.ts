// Shared diff engine, dependency-free. Produces pi's display-diff format
// (sign + padded line number + content per line, "..." skip markers) and
// token-level segments for word highlight overlays. Imported by both the
// frontend (vite) and the bridge (node strip-types), so only erasable
// TypeScript is used here.

/** One step of an edit script over aligned sequences. */
export type DiffOp =
  | { type: "common"; aIdx: number; bIdx: number }
  | { type: "del"; aIdx: number }
  | { type: "add"; bIdx: number };

/** Contiguous run of a word-diff: changed text on one side, or unchanged. */
export type WordSeg = { text: string; changed: boolean };

/** Cost guard for the O(ND) Myers pass: beyond this, degrade to full replace. */
const MYERS_CELL_LIMIT = 40_000;

/**
 * Myers O(ND) diff of two string sequences with trace-back, returning the
 * edit script in document order. Above the cell limit it degrades to
 * "delete all, add all" instead of exhausting time or memory.
 */
function myersOps(a: string[], b: string[]): DiffOp[] {
  if (a.length + b.length > MYERS_CELL_LIMIT) {
    const ops: DiffOp[] = [];
    for (let i = 0; i < a.length; i++) ops.push({ type: "del", aIdx: i });
    for (let j = 0; j < b.length; j++) ops.push({ type: "add", bIdx: j });
    return ops;
  }
  const max = a.length + b.length;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  // Snapshot of v before each step d; trace[d] is the state the moves of
  // step d were derived from.
  const trace: Int32Array[] = [];
  let foundD = -1;
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + off]! < v[k + 1 + off]!)) {
        x = v[k + 1 + off]!; // down move (insertion from b)
      } else {
        x = v[k - 1 + off]! + 1; // right move (deletion from a)
      }
      let y = x - k;
      while (x < a.length && y < b.length && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k + off] = x;
      if (x >= a.length && y >= b.length) {
        foundD = d;
        break outer;
      }
    }
  }
  const ops: DiffOp[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = foundD; d >= 1; d--) {
    const vt = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && vt[k - 1 + off]! < vt[k + 1 + off]!) ? k + 1 : k - 1;
    const prevX = vt[prevK + off]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ type: "common", aIdx: x, bIdx: y });
    }
    if (prevK === k + 1) ops.push({ type: "add", bIdx: prevY });
    else ops.push({ type: "del", aIdx: prevX });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    ops.push({ type: "common", aIdx: x, bIdx: y });
  }
  ops.reverse();
  return ops;
}

/** Split text into lines the way pi's display diff counts them. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Format the diff of two texts in pi's display format: `+N text`, `-N text`,
 * ` N text` for context, ` N...`-style skip markers over unchanged gaps longer
 * than 2 * contextLines. Matching pi keeps one parser for both the preview
 * (bridge-computed) and the final (pi-computed) diff.
 */
export function formatLineDiff(oldText: string, newText: string, contextLines = 4): string {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  // Trim common prefix/suffix so Myers works on the changed middle only.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const mid = myersOps(a.slice(start, endA), b.slice(start, endB));

  type Row = { kind: "ctx" | "del" | "add"; numA: number; numB: number; text: string };
  const rows: Row[] = [];
  // Prefix and suffix are common runs; the middle ops carry shifted indices.
  for (let i = 0; i < start; i++) rows.push({ kind: "ctx", numA: i + 1, numB: i + 1, text: a[i]! });
  let numA = start;
  let numB = start;
  for (const op of mid) {
    if (op.type === "common") {
      numA++;
      numB++;
      rows.push({ kind: "ctx", numA, numB, text: a[start + op.aIdx]! });
    } else if (op.type === "del") {
      numA++;
      rows.push({ kind: "del", numA, numB, text: a[start + op.aIdx]! });
    } else {
      numB++;
      rows.push({ kind: "add", numA, numB, text: b[start + op.bIdx]! });
    }
  }
  // Suffix continues both counters from where the middle ended.
  for (let i = endA; i < a.length; i++) {
    numA++;
    numB++;
    rows.push({ kind: "ctx", numA, numB, text: a[i]! });
  }

  // Include context around each change run, merge overlaps, mark gaps.
  if (!rows.some((row) => row.kind !== "ctx")) return ""; // identical content
  const width = String(Math.max(a.length, b.length, 1)).length;
  const skip = ` ${" ".repeat(width)} ...`;
  const included = new Array<boolean>(rows.length).fill(false);
  let i = 0;
  while (i < rows.length) {
    if (rows[i]!.kind === "ctx") {
      i++;
      continue;
    }
    let end = i;
    while (end < rows.length && rows[end]!.kind !== "ctx") end++;
    for (let j = Math.max(0, i - contextLines); j < Math.min(rows.length, end + contextLines); j++) {
      included[j] = true;
    }
    i = end;
  }
  const out: string[] = [];
  let skipped = 0;
  for (let idx = 0; idx < rows.length; idx++) {
    const row = rows[idx]!;
    const num = row.kind === "add" ? row.numB : row.numA;
    if (included[idx]) {
      if (skipped > 0) {
        out.push(skip);
        skipped = 0;
      }
      const sign = row.kind === "add" ? "+" : row.kind === "del" ? "-" : " ";
      out.push(`${sign}${String(num).padStart(width, " ")} ${row.text}`);
    } else {
      skipped++;
    }
  }
  if (skipped > 0) out.push(skip);
  return out.join("\n");
}

const TOKEN_RE = /[A-Za-z0-9_$]+|\s+|[^\sA-Za-z0-9_$]/g;

/** Token-level diff for word highlight: [old-side segments, new-side segments]. */
export function diffWords(oldText: string, newText: string): [WordSeg[], WordSeg[]] | null {
  const a = oldText.match(TOKEN_RE) ?? [];
  const b = newText.match(TOKEN_RE) ?? [];
  if (a.length + b.length > 1200) return null; // minified lines: skip overlay
  const ops = myersOps(a, b);
  const segsA: WordSeg[] = [];
  const segsB: WordSeg[] = [];
  const push = (segs: WordSeg[], text: string, changed: boolean): void => {
    const last = segs[segs.length - 1];
    if (last && last.changed === changed) last.text += text;
    else segs.push({ text, changed });
  };
  for (const op of ops) {
    if (op.type === "common") {
      push(segsA, a[op.aIdx]!, false);
      push(segsB, b[op.bIdx]!, false);
    } else if (op.type === "del") {
      push(segsA, a[op.aIdx]!, true);
    } else {
      push(segsB, b[op.bIdx]!, true);
    }
  }
  return [segsA, segsB];
}
