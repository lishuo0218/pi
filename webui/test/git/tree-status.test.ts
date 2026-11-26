// Git tracking marks for the file tree: how one status entry folds into a row
// mark, and how the tree's cwd-relative paths map onto repo-relative ones.
import { describe, expect, it } from "vitest";
import { dirChange, markOf, repoPath, repoPrefix } from "../../src/git/tree-status.ts";
import type { GitFile } from "../../bridge/git/types.ts";

/** A status entry with everything but the tested fields set to a clean value. */
function entry(fields: Partial<GitFile>): GitFile {
  return {
    path: "a.txt",
    origPath: null,
    index: ".",
    worktree: ".",
    untracked: false,
    conflict: null,
    indexStats: null,
    worktreeStats: null,
    ...fields,
  };
}

describe("markOf", () => {
  it("keeps the staged letter and the worktree letter apart", () => {
    expect(markOf(entry({ index: "M", worktree: "M" }))).toEqual({
      staged: "M",
      worktree: "M",
      untracked: false,
      conflict: false,
    });
  });

  it("drops the clean side", () => {
    expect(markOf(entry({ index: ".", worktree: "M" })).staged).toBeNull();
    expect(markOf(entry({ index: "A", worktree: "." })).worktree).toBeNull();
    expect(markOf(entry({ index: ".", worktree: "." }))).toMatchObject({ staged: null, worktree: null });
  });

  it("reports an untracked path once, not as two question marks", () => {
    expect(markOf(entry({ index: "?", worktree: "?", untracked: true }))).toEqual({
      staged: null,
      worktree: null,
      untracked: true,
      conflict: false,
    });
  });

  it("flags a conflicted path", () => {
    expect(markOf(entry({ index: "U", worktree: "U", conflict: "bothModified" })).conflict).toBe(true);
  });
});

describe("dirChange", () => {
  it("reports a conflicted path first", () => {
    expect(dirChange(entry({ index: "U", worktree: "U", conflict: "bothModified" }))).toBe("conflict");
  });

  it("prefers a worktree edit over an index-only change", () => {
    expect(dirChange(entry({ index: "M", worktree: "M" }))).toBe("worktree");
    expect(dirChange(entry({ index: ".", worktree: "D" }))).toBe("worktree");
  });

  it("reports an index-only change as staged", () => {
    expect(dirChange(entry({ index: "A", worktree: "." }))).toBe("staged");
    expect(dirChange(entry({ index: "R", worktree: "." }))).toBe("staged");
  });

  it("reports an untracked path", () => {
    expect(dirChange(entry({ index: "?", worktree: "?", untracked: true }))).toBe("untracked");
  });

  it("is null for a clean path", () => {
    expect(dirChange(entry({}))).toBeNull();
  });
});

describe("repoPrefix", () => {
  it("is empty at the repository top level", () => {
    expect(repoPrefix("/w/repo", "/w/repo")).toBe("");
    expect(repoPrefix("/w/repo/", "/w/repo//")).toBe("");
  });

  it("is the relative path of a nested working directory", () => {
    expect(repoPrefix("/w/repo", "/w/repo/webui/src")).toBe("webui/src");
    expect(repoPrefix("/w/repo", "/w/repo/webui/")).toBe("webui");
  });

  it("accepts Windows separators and case differences", () => {
    expect(repoPrefix("D:/download/pi", "D:\\download\\pi\\webui")).toBe("webui");
    expect(repoPrefix("D:/download/pi", "d:\\download\\pi")).toBe("");
  });

  it("is null outside the repository and on sibling names", () => {
    expect(repoPrefix("/w/repo", "/w/other")).toBeNull();
    expect(repoPrefix("/w/repo", "/w/repository")).toBeNull();
  });
});

describe("repoPath", () => {
  it("passes tree paths through at the top level", () => {
    expect(repoPath("", "src/a.ts")).toBe("src/a.ts");
  });

  it("joins the cwd prefix", () => {
    expect(repoPath("webui", "src/a.ts")).toBe("webui/src/a.ts");
    expect(repoPath("webui", "")).toBe("webui");
  });
});