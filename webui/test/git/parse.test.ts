// Patch parsing for the diff pane: line numbering across hunks and files,
// folding of long context runs, and the find bar's hit positions.
import { describe, expect, it } from "vitest";
import { buildDisplay, displayIndexOf, findHits, parsePatch, type DiffRow } from "../../src/git/diff-parse.ts";

const PATCH = [
  "diff --git a/a.txt b/a.txt",
  "index 1111111..2222222 100644",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -1,3 +1,3 @@",
  " ctx one",
  "-old",
  "+new",
  " ctx two",
  "\\ No newline at end of file",
  "diff --git a/b.txt b/b.txt",
  "--- a/b.txt",
  "+++ b/b.txt",
  "@@ -10,3 +10,3 @@",
  "-x",
  "+y",
  " ctx three",
  "",
].join("\n");

describe("parsePatch", () => {
  it("numbers both sides and resets the counters per hunk", () => {
    const rows = parsePatch(PATCH);
    expect(rows[0]).toEqual({ kind: "meta", text: "diff --git a/a.txt b/a.txt" });
    expect(rows[4]).toEqual({ kind: "hunk", text: "@@ -1,3 +1,3 @@", hunk: 0 });
    expect(rows[5]).toEqual({ kind: "ctx", text: "ctx one", old: 1, new: 1, hunk: 0 });
    expect(rows[6]).toEqual({ kind: "del", text: "old", old: 2, hunk: 0 });
    expect(rows[7]).toEqual({ kind: "add", text: "new", new: 2, hunk: 0 });
    expect(rows[8]).toEqual({ kind: "ctx", text: "ctx two", old: 3, new: 3, hunk: 0 });
    expect(rows[9]).toEqual({ kind: "note", text: "\\ No newline at end of file" });
  });

  it("keeps counting hunks across files and starts the second file's lines at its header", () => {
    const rows = parsePatch(PATCH);
    const header = rows.find((row) => row.kind === "hunk" && row.text.includes("+10"));
    expect(header).toEqual({ kind: "hunk", text: "@@ -10,3 +10,3 @@", hunk: 1 });
    expect(rows[rows.length - 1]).toEqual({ kind: "ctx", text: "ctx three", old: 11, new: 11, hunk: 1 });
  });

  it("treats file headers after a hunk as meta, not as added lines", () => {
    const rows = parsePatch(PATCH);
    expect(rows.filter((row) => row.kind === "meta").map((row) => row.text)).toContain("--- a/b.txt");
    expect(rows.filter((row) => row.kind === "add").map((row) => row.text)).toEqual(["new", "y"]);
  });

  it("returns nothing for an empty patch", () => {
    expect(parsePatch("")).toEqual([]);
  });
});

/** A patch with one hunk holding `count` unchanged lines. */
function contextPatch(count: number, prefix = "ctx"): string {
  const body = Array.from({ length: count }, (_, index) => ` ${prefix} ${index + 1}`);
  return ["diff --git a/a.txt b/a.txt", "--- a/a.txt", "+++ b/a.txt", `@@ -1,${count} +1,${count} @@`, ...body].join("\n");
}

describe("buildDisplay", () => {
  it("folds a long context run into one row between its kept edges", () => {
    const rows = parsePatch(contextPatch(20));
    const display = buildDisplay(rows, new Set());
    // three file headers + hunk header + 3 kept + fold + 3 kept
    expect(display).toHaveLength(11);
    expect(display[0]?.kind).toBe("row");
    expect(display[7]).toEqual({ kind: "fold", id: 0, count: 14 });
    expect(display[8]).toMatchObject({ kind: "row", row: { text: "ctx 18" } });
  });

  it("keeps a short run inline", () => {
    const rows = parsePatch(contextPatch(6));
    // three file headers + hunk header + the six context rows
    expect(buildDisplay(rows, new Set())).toHaveLength(10);
  });

  it("opens a fold by id and every fold with all", () => {
    const rows = parsePatch(contextPatch(20));
    expect(buildDisplay(rows, new Set([0]))).toHaveLength(24);
    expect(buildDisplay(rows, "all")).toHaveLength(24);
  });

  it("keeps fold ids stable when a later fold is opened", () => {
    const body = [
      ...Array.from({ length: 20 }, (_, index) => ` ctx ${index + 1}`),
      "-old",
      "+new",
      ...Array.from({ length: 20 }, (_, index) => ` ctx ${index + 21}`),
    ];
    const rows = parsePatch(["@@ -1,41 +1,41 @@", ...body].join("\n"));
    const folded = buildDisplay(rows, new Set());
    expect(folded.filter((entry) => entry.kind === "fold")).toEqual([
      { kind: "fold", id: 0, count: 14 },
      { kind: "fold", id: 1, count: 14 },
    ]);
    const opened = buildDisplay(rows, new Set([1]));
    expect(opened.filter((entry) => entry.kind === "fold")).toEqual([{ kind: "fold", id: 0, count: 14 }]);
  });
});

describe("findHits and displayIndexOf", () => {
  it("finds matches inside content rows only", () => {
    const rows = parsePatch(contextPatch(3, "needle"));
    const hits = findHits(rows, "needle", { caseSensitive: false, regex: false });
    expect(hits).toHaveLength(3);
    expect(hits[0]).toMatchObject({ start: 0, length: 6 });
    expect(findHits(rows, "50000", { caseSensitive: false, regex: false })).toEqual([]);
  });

  it("honours case sensitivity and regular expressions", () => {
    const rows = parsePatch(contextPatch(2, "Needle"));
    expect(findHits(rows, "needle", { caseSensitive: true, regex: false })).toEqual([]);
    expect(findHits(rows, "needle", { caseSensitive: false, regex: false })).toHaveLength(2);
    expect(findHits(rows, "needle \\d", { caseSensitive: false, regex: true })).toHaveLength(2);
  });

  it("returns nothing for an invalid expression", () => {
    const rows = parsePatch(contextPatch(2));
    expect(findHits(rows, "(", { caseSensitive: false, regex: true })).toEqual([]);
  });

  it("maps a patch row to its display index and back to -1 when folded away", () => {
    const rows = parsePatch(contextPatch(20));
    const display = buildDisplay(rows, new Set());
    expect(displayIndexOf(display, 0)).toBe(0);
    expect(displayIndexOf(display, 3)).toBe(3);
    // Patch rows 7..20 hide inside the fold.
    expect(displayIndexOf(display, 10)).toBe(-1);
    const opened = buildDisplay(rows, new Set([0]));
    expect(displayIndexOf(opened, 10)).toBe(10);
  });
});

/** Every display entry that is a real patch row, for order assertions. */
function rowsOf(display: ReturnType<typeof buildDisplay>): DiffRow[] {
  const out: DiffRow[] = [];
  for (const entry of display) {
    if (entry.kind === "row") out.push(entry.row);
  }
  return out;
}

describe("display order", () => {
  it("keeps patch rows in order around a fold", () => {
    const rows = parsePatch(contextPatch(20));
    const kept = rowsOf(buildDisplay(rows, new Set()));
    expect(kept.map((row) => (row.kind === "ctx" ? row.text : row.kind))).toEqual([
      "meta",
      "meta",
      "meta",
      "hunk",
      "ctx 1",
      "ctx 2",
      "ctx 3",
      "ctx 18",
      "ctx 19",
      "ctx 20",
    ]);
  });
});