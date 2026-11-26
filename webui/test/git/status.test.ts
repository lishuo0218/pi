// Status parsing against real repositories: branch header, both sides of a
// partially staged file, untracked files, renames, and the setup error for a
// directory that is not a repository.
import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { call, cleanupAll, commitAll, git, makeDir, makeRepo, statusOf, write, type Fixture } from "./helpers.ts";

const fixtures: Fixture[] = [];
afterEach(() => cleanupAll(fixtures));

async function repo(): Promise<string> {
  const fixture = await makeRepo();
  fixtures.push(fixture);
  return fixture.dir;
}

describe("status", () => {
  it("reports an unborn branch with no files", async () => {
    const fixture = await makeDir();
    fixtures.push(fixture);
    await git(fixture.dir, ["init", "-q", "-b", "main"]);
    const status = statusOf(await call(fixture.dir, { action: "status" }));
    expect(status.branch).toBe("main");
    expect(status.unborn).toBe(true);
    expect(status.files).toEqual([]);
    expect(status.operation).toBeNull();
  });

  it("reports a committed branch as born and in sync with itself", async () => {
    const dir = await repo();
    const status = statusOf(await call(dir, { action: "status" }));
    expect(status.unborn).toBe(false);
    expect(status.upstream).toBeNull();
    expect([status.ahead, status.behind]).toEqual([0, 0]);
  });

  it("splits a partially staged file into one index side and one worktree side", async () => {
    const dir = await repo();
    await write(dir, "a.txt", "one\ntwo\nthree\nfour\n");
    await commitAll(dir, "base");
    await write(dir, "a.txt", "one\nstaged\nthree\nfour\n");
    await git(dir, ["add", "a.txt"]);
    await write(dir, "a.txt", "one\nstaged\nworktree\nfour\nfive\n");

    const status = statusOf(await call(dir, { action: "status" }));
    const file = status.files.find((entry) => entry.path === "a.txt");
    expect(file).toBeDefined();
    expect(file?.index).toBe("M");
    expect(file?.worktree).toBe("M");
    expect(file?.untracked).toBe(false);
    expect(file?.conflict).toBeNull();
    // Each side counts only its own patch: the index against HEAD, the worktree
    // against the index.
    expect(file?.indexStats).toEqual({ add: 1, del: 1 });
    expect(file?.worktreeStats).toEqual({ add: 2, del: 1 });
  });

  it("marks untracked files and counts worktree line changes", async () => {
    const dir = await repo();
    await write(dir, "a.txt", "one\ntwo\nthree\n");
    await commitAll(dir, "base");
    await write(dir, "a.txt", "one\nchanged\nthree\n");
    await write(dir, "fresh.txt", "hello\n");

    const status = statusOf(await call(dir, { action: "status" }));
    const changed = status.files.find((entry) => entry.path === "a.txt");
    const fresh = status.files.find((entry) => entry.path === "fresh.txt");
    expect(changed?.indexStats).toBeNull();
    expect(changed?.worktreeStats).toEqual({ add: 1, del: 1 });
    expect(fresh?.untracked).toBe(true);
    // Untracked paths are in no diff, so git reports no counts for them.
    expect(fresh?.indexStats).toBeNull();
    expect(fresh?.worktreeStats).toBeNull();
  });

  it("reports a staged rename with its original path and zero line counts", async () => {
    const dir = await repo();
    await write(dir, "old.txt", "content\n");
    await commitAll(dir, "base");
    await git(dir, ["mv", "old.txt", "new.txt"]);

    const status = statusOf(await call(dir, { action: "status" }));
    const file = status.files.find((entry) => entry.path === "new.txt");
    expect(file?.origPath).toBe("old.txt");
    expect(file?.index).toBe("R");
    // The rename numstat record names the new path after two extra NUL fields.
    expect(file?.indexStats).toEqual({ add: 0, del: 0 });
  });

  it("reports null counts for a binary patch", async () => {
    const dir = await repo();
    await write(dir, "blob.bin", "a\u0000b\n");
    await commitAll(dir, "base");
    await write(dir, "blob.bin", "c\u0000d\n");
    await git(dir, ["add", "blob.bin"]);

    const status = statusOf(await call(dir, { action: "status" }));
    const file = status.files.find((entry) => entry.path === "blob.bin");
    expect(file?.indexStats).toEqual({ add: null, del: null });
  });

  it("keeps path spacing and non-ASCII names verbatim", async () => {
    const dir = await repo();
    await write(dir, "dir name/文件 (1).txt", "x\n");
    await commitAll(dir, "base");
    await write(dir, "dir name/文件 (1).txt", "y\n");

    const status = statusOf(await call(dir, { action: "status" }));
    expect(status.files.map((entry) => entry.path)).toContain("dir name/文件 (1).txt");
  });

  it("resolves the repository from a subdirectory", async () => {
    const dir = await repo();
    await write(dir, "sub/deep/file.txt", "x\n");
    const status = statusOf(await call(join(dir, "sub", "deep"), { action: "status" }));
    expect(status.root).toBe(await git(dir, ["rev-parse", "--show-toplevel"]).then((out) => out.trim()));
    expect(status.files.map((entry) => entry.path)).toContain("sub/deep/file.txt");
  });

  it("reports a non-repository directory as a setup error", async () => {
    const fixture = await makeDir();
    fixtures.push(fixture);
    const reply = await call(fixture.dir, { action: "status" });
    expect(reply.ok).toBe(false);
    if (reply.ok) return;
    expect(reply.code).toBe("not-a-repo");
  });
});