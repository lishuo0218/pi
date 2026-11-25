// Request validation: the POST body is a trust boundary, so every malformed or
// hostile field must be refused before git runs. Paths are repository-relative,
// option-looking paths and escaping segments are rejected, and a hunk op must be
// paired with the side it reads.
import { describe, expect, it } from "vitest";
import { parseRequest } from "../../bridge/git/validate.ts";

describe("parseRequest", () => {
  it("accepts the documented actions", () => {
    expect(parseRequest({ action: "status" })).toEqual({ action: "status" });
    expect(parseRequest({ action: "fileDiff", path: "a.txt", side: "index", context: "full" })).toEqual({
      action: "fileDiff",
      path: "a.txt",
      side: "index",
      context: "full",
    });
    expect(parseRequest({ action: "log", limit: 50, skip: 100 })).toEqual({
      action: "log",
      limit: 50,
      skip: 100,
      rev: null,
      all: false,
      query: null,
    });
    expect(parseRequest({ action: "log", limit: 10, skip: 0, rev: "refs/heads/main", query: "fix" })).toEqual({
      action: "log",
      limit: 10,
      skip: 0,
      rev: "refs/heads/main",
      all: false,
      query: "fix",
    });
    expect(parseRequest({ action: "stage", paths: ["a.txt", "dir/b.txt"] })).toEqual({
      action: "stage",
      paths: ["a.txt", "dir/b.txt"],
    });
    expect(parseRequest({ action: "commit", message: "msg", amend: true })).toEqual({
      action: "commit",
      message: "msg",
      amend: true,
    });
    expect(parseRequest({ action: "refs" })).toEqual({ action: "refs" });
    expect(parseRequest({ action: "commitDetail", sha: "a1b2c3d" })).not.toBeNull();
    expect(parseRequest({ action: "commitFileDiff", sha: "a1b2c3d", path: "a.txt" })).not.toBeNull();
    expect(parseRequest({ action: "commitFileDiff", sha: "a1b2c3d", path: "../b" })).toBeNull();
    // Network actions carry no fields at all.
    for (const action of ["fetch", "pull", "push"]) {
      expect(parseRequest({ action })).toEqual({ action });
    }
  });

  it("refuses unknown actions and non-object bodies", () => {
    expect(parseRequest(null)).toBeNull();
    expect(parseRequest("status")).toBeNull();
    expect(parseRequest({ action: "clone" })).toBeNull();
    expect(parseRequest({})).toBeNull();
  });

  it("refuses paths that leave the repository or look like options", () => {
    for (const path of ["/etc/passwd", "C:/Windows", "../outside", "a/../../b", "-rf", "--cached"]) {
      expect(parseRequest({ action: "stage", paths: [path] })).toBeNull();
    }
  });

  it("refuses empty and oversized path lists", () => {
    expect(parseRequest({ action: "stage", paths: [] })).toBeNull();
    expect(parseRequest({ action: "stage", paths: ["a"] })).not.toBeNull();
    const many = Array.from({ length: 5_001 }, (_, index) => `f${index}.txt`);
    expect(parseRequest({ action: "stage", paths: many })).toBeNull();
  });

  it("refuses a discard scope it does not implement", () => {
    expect(parseRequest({ action: "discard", paths: ["a"], scope: "index" })).toBeNull();
    expect(parseRequest({ action: "discard", paths: ["a"], scope: "untracked" })).not.toBeNull();
  });

  it("refuses a hunk whose side and op disagree", () => {
    const base = { action: "hunk", path: "a.txt", context: "small", hunk: 0 };
    expect(parseRequest({ ...base, side: "index", op: "stage" })).toBeNull();
    expect(parseRequest({ ...base, side: "worktree", op: "stage" })).not.toBeNull();
    expect(parseRequest({ ...base, side: "index", op: "unstage" })).not.toBeNull();
    expect(parseRequest({ ...base, side: "worktree", op: "unstage" })).toBeNull();
    expect(parseRequest({ ...base, side: "worktree", op: "discard" })).not.toBeNull();
    expect(parseRequest({ ...base, side: "index", op: "discard" })).toBeNull();
  });

  it("refuses a hunk index that is not a non-negative integer", () => {
    expect(parseRequest({ action: "hunk", path: "a.txt", side: "worktree", context: "small", hunk: -1, op: "stage" })).toBeNull();
    expect(parseRequest({ action: "hunk", path: "a.txt", side: "worktree", context: "small", hunk: 1.5, op: "stage" })).toBeNull();
  });

  it("refuses a commit sha that is not hexadecimal", () => {
    expect(parseRequest({ action: "commitDiff", sha: "HEAD" })).toBeNull();
    expect(parseRequest({ action: "commitDiff", sha: "abc" })).toBeNull();
    expect(parseRequest({ action: "commitDiff", sha: "a1b2c3d" })).not.toBeNull();
  });

  it("caps the commit message and refuses NUL bytes", () => {
    expect(parseRequest({ action: "commit", message: "x".repeat(100_001), amend: false })).toBeNull();
    expect(parseRequest({ action: "commit", message: "a\0b", amend: false })).toBeNull();
  });

  it("refuses a walk that both names a ref and covers every ref", () => {
    expect(parseRequest({ action: "log", limit: 10, skip: 0, rev: "refs/heads/main", all: true })).toBeNull();
  });

  it("refuses revisions and queries that git would read as options or syntax", () => {
    for (const rev of ["-n1", "--all", "a..b", "a~1", "main@{1}", "/main", "main/", "main.lock", "a b"]) {
      expect(parseRequest({ action: "log", limit: 10, skip: 0, rev })).toBeNull();
    }
    const nul = String.fromCharCode(0);
    const lf = String.fromCharCode(10);
    for (const query of [`a${nul}b`, `a${lf}b`, "x".repeat(201)]) {
      expect(parseRequest({ action: "log", limit: 10, skip: 0, query })).toBeNull();
    }
  });

  it("keeps the log page bounded", () => {
    expect(parseRequest({ action: "log", limit: 0, skip: 0 })).toBeNull();
    expect(parseRequest({ action: "log", limit: 201, skip: 0 })).toBeNull();
    expect(parseRequest({ action: "log", limit: 1, skip: -1 })).toBeNull();
  });
});