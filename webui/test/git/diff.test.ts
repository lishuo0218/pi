// Patches and hunk writes against real repositories: both sides of a file, a
// synthesized new-file diff for untracked files, staging / unstaging / discarding
// a single hunk while the other hunk stays put, stale hunk indices, full context,
// binary files and one commit's diff.
import { afterEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { call, cleanupAll, commitAll, diffOf, errorOf, git, lines, makeRepo, statusOf, write, type Fixture } from "./helpers.ts";

const fixtures: Fixture[] = [];
afterEach(() => cleanupAll(fixtures));

async function repoWithTwoHunks(): Promise<string> {
  const fixture = await makeRepo();
  fixtures.push(fixture);
  const dir = fixture.dir;
  await write(dir, "a.txt", lines(20));
  await commitAll(dir, "base");
  await write(dir, "a.txt", lines(20).replace("line 2\n", "CHANGED 2\n").replace("line 18\n", "CHANGED 18\n"));
  return dir;
}

describe("file patches", () => {
  it("reads the worktree side and the index side of one file", async () => {
    const fixture = await makeRepo();
    fixtures.push(fixture);
    const dir = fixture.dir;
    await write(dir, "a.txt", "one\ntwo\n");
    await commitAll(dir, "base");
    await write(dir, "a.txt", "one\nstaged\n");
    await git(dir, ["add", "a.txt"]);
    await write(dir, "a.txt", "one\nworktree\n");

    const worktree = diffOf(await call(dir, { action: "fileDiff", path: "a.txt", side: "worktree", context: "small" }));
    const index = diffOf(await call(dir, { action: "fileDiff", path: "a.txt", side: "index", context: "small" }));
    expect(worktree.text).toContain("+worktree");
    expect(worktree.text).not.toContain("+staged");
    expect(index.text).toContain("+staged");
    expect(index.text).not.toContain("+worktree");
  });

  it("is empty for a clean side", async () => {
    const fixture = await makeRepo();
    fixtures.push(fixture);
    await write(fixture.dir, "a.txt", "one\n");
    await commitAll(fixture.dir, "base");
    const diff = diffOf(await call(fixture.dir, { action: "fileDiff", path: "a.txt", side: "worktree", context: "small" }));
    expect(diff.text).toBe("");
    expect(diff.binary).toBe(false);
  });

  it("synthesizes a new-file patch for an untracked file", async () => {
    const fixture = await makeRepo();
    fixtures.push(fixture);
    await write(fixture.dir, "fresh.txt", "hello\nworld\n");
    const diff = diffOf(await call(fixture.dir, { action: "fileDiff", path: "fresh.txt", side: "worktree", context: "small" }));
    expect(diff.text).toContain("new file mode");
    expect(diff.text).toContain("+hello");
    expect(diff.text).toContain("@@ -0,0 +1,2 @@");
  });

  it("flags an untracked binary file instead of printing bytes", async () => {
    const fixture = await makeRepo();
    fixtures.push(fixture);
    await write(fixture.dir, "bin.dat", "a\0b");
    const diff = diffOf(await call(fixture.dir, { action: "fileDiff", path: "bin.dat", side: "worktree", context: "small" }));
    expect(diff.binary).toBe(true);
    expect(diff.text).toBe("");
  });

  it("carries every unchanged line with full context", async () => {
    const fixture = await makeRepo();
    fixtures.push(fixture);
    const dir = fixture.dir;
    await write(dir, "long.txt", lines(300));
    await commitAll(dir, "base");
    await write(dir, "long.txt", lines(300).replace("line 1\n", "CHANGED 1\n"));

    const small = diffOf(await call(dir, { action: "fileDiff", path: "long.txt", side: "worktree", context: "small" }));
    const full = diffOf(await call(dir, { action: "fileDiff", path: "long.txt", side: "worktree", context: "full" }));
    expect(small.text).not.toContain("line 250");
    expect(full.text).toContain("line 250");
    expect(small.text).toContain("+CHANGED 1");
  });

  it("reads one commit's patch", async () => {
    const fixture = await makeRepo();
    fixtures.push(fixture);
    const dir = fixture.dir;
    await write(dir, "a.txt", "one\n");
    const sha = (await commitAll(dir, "add a")).trim();
    const diff = diffOf(await call(dir, { action: "commitDiff", sha }));
    expect(diff.text).toContain("+one");
  });
});

describe("hunk writes", () => {
  it("stages one hunk and leaves the other in the worktree", async () => {
    const dir = await repoWithTwoHunks();
    const staged = await call(dir, { action: "hunk", path: "a.txt", side: "worktree", context: "small", hunk: 0, op: "stage" });
    expect(staged.ok).toBe(true);

    const index = diffOf(await call(dir, { action: "fileDiff", path: "a.txt", side: "index", context: "small" }));
    const worktree = diffOf(await call(dir, { action: "fileDiff", path: "a.txt", side: "worktree", context: "small" }));
    expect(index.text).toContain("CHANGED 2");
    expect(index.text).not.toContain("CHANGED 18");
    expect(worktree.text).toContain("CHANGED 18");
    expect(worktree.text).not.toContain("CHANGED 2");

    const status = statusOf(await call(dir, { action: "status" }));
    const file = status.files.find((entry) => entry.path === "a.txt");
    expect([file?.index, file?.worktree]).toEqual(["M", "M"]);
    // The worktree file itself never changed.
    expect(await readFile(join(dir, "a.txt"), "utf-8")).toContain("CHANGED 18");
  });

  it("unstages one hunk without touching the worktree", async () => {
    const dir = await repoWithTwoHunks();
    await call(dir, { action: "stage", paths: ["a.txt"] });
    const unstaged = await call(dir, { action: "hunk", path: "a.txt", side: "index", context: "small", hunk: 0, op: "unstage" });
    expect(unstaged.ok).toBe(true);

    const index = diffOf(await call(dir, { action: "fileDiff", path: "a.txt", side: "index", context: "small" }));
    const worktree = diffOf(await call(dir, { action: "fileDiff", path: "a.txt", side: "worktree", context: "small" }));
    expect(index.text).toContain("CHANGED 18");
    expect(index.text).not.toContain("CHANGED 2");
    expect(worktree.text).toContain("CHANGED 2");
  });

  it("discards one hunk and keeps the other", async () => {
    const dir = await repoWithTwoHunks();
    const discarded = await call(dir, { action: "hunk", path: "a.txt", side: "worktree", context: "small", hunk: 1, op: "discard" });
    expect(discarded.ok).toBe(true);

    const content = await readFile(join(dir, "a.txt"), "utf-8");
    expect(content).toContain("CHANGED 2");
    expect(content).not.toContain("CHANGED 18");
    expect(content).toContain("line 18");
  });

  it("refuses a hunk index that no longer exists", async () => {
    const dir = await repoWithTwoHunks();
    const reply = await call(dir, { action: "hunk", path: "a.txt", side: "worktree", context: "small", hunk: 7, op: "stage" });
    expect(errorOf(reply).error).toContain("请刷新");
  });

  it("refuses a hunk op paired with the wrong side", async () => {
    const dir = await repoWithTwoHunks();
    const reply = await call(dir, { action: "hunk", path: "a.txt", side: "index", context: "small", hunk: 0, op: "stage" });
    expect(errorOf(reply).code).toBe("invalid-request");
  });
});