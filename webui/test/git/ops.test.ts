// Write actions against real repositories: stage, unstage (born and unborn
// branches), the three discard scopes, commit, amend, and the queue that keeps
// two overlapping writes from failing on the index lock.
import { afterEach, describe, expect, it } from "vitest";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { call, cleanupAll, commitAll, errorOf, git, makeRepo, statusOf, write, type Fixture } from "./helpers.ts";

const fixtures: Fixture[] = [];
afterEach(() => cleanupAll(fixtures));

async function repo(): Promise<string> {
  const fixture = await makeRepo();
  fixtures.push(fixture);
  return fixture.dir;
}

async function commitCount(dir: string): Promise<number> {
  return Number((await git(dir, ["rev-list", "--count", "HEAD"])).trim());
}

describe("stage and unstage", () => {
  it("moves a change from the worktree side to the index side", async () => {
    const dir = await repo();
    await write(dir, "a.txt", "one\n");
    await commitAll(dir, "base");
    await write(dir, "a.txt", "two\n");

    expect((await call(dir, { action: "stage", paths: ["a.txt"] })).ok).toBe(true);
    const status = statusOf(await call(dir, { action: "status" }));
    const file = status.files.find((entry) => entry.path === "a.txt");
    expect([file?.index, file?.worktree]).toEqual(["M", "."]);

    expect((await call(dir, { action: "unstage", paths: ["a.txt"] })).ok).toBe(true);
    const restored = statusOf(await call(dir, { action: "status" }));
    const again = restored.files.find((entry) => entry.path === "a.txt");
    expect([again?.index, again?.worktree]).toEqual([".", "M"]);
  });

  it("unstages on an unborn branch by dropping the index entry", async () => {
    const fixture = await makeRepo();
    fixtures.push(fixture);
    const dir = fixture.dir;
    await git(dir, ["update-ref", "-d", "HEAD"]);
    await write(dir, "a.txt", "one\n");
    await call(dir, { action: "stage", paths: ["a.txt"] });

    const staged = statusOf(await call(dir, { action: "status" }));
    expect(staged.unborn).toBe(true);
    expect(staged.files.find((entry) => entry.path === "a.txt")?.index).toBe("A");

    expect((await call(dir, { action: "unstage", paths: ["a.txt"] })).ok).toBe(true);
    const after = statusOf(await call(dir, { action: "status" }));
    expect(after.files.find((entry) => entry.path === "a.txt")?.untracked).toBe(true);
  });

  it("rejects a path that escapes the repository", async () => {
    const dir = await repo();
    const reply = await call(dir, { action: "stage", paths: ["../outside.txt"] });
    expect(errorOf(reply).code).toBe("invalid-request");
  });
});

describe("discard", () => {
  it("restores the worktree and keeps the index", async () => {
    const dir = await repo();
    await write(dir, "a.txt", "one\n");
    await commitAll(dir, "base");
    await write(dir, "a.txt", "staged\n");
    await git(dir, ["add", "a.txt"]);
    await write(dir, "a.txt", "worktree\n");

    expect((await call(dir, { action: "discard", paths: ["a.txt"], scope: "worktree" })).ok).toBe(true);
    const status = statusOf(await call(dir, { action: "status" }));
    const file = status.files.find((entry) => entry.path === "a.txt");
    expect([file?.index, file?.worktree]).toEqual(["M", "."]);
  });

  it("drops staged and worktree changes with scope all", async () => {
    const dir = await repo();
    await write(dir, "a.txt", "one\n");
    await commitAll(dir, "base");
    await write(dir, "a.txt", "changed\n");
    await git(dir, ["add", "a.txt"]);

    expect((await call(dir, { action: "discard", paths: ["a.txt"], scope: "all" })).ok).toBe(true);
    const status = statusOf(await call(dir, { action: "status" }));
    expect(status.files).toEqual([]);
  });

  it("deletes untracked files with scope untracked", async () => {
    const dir = await repo();
    await write(dir, "fresh/nested.txt", "x\n");

    expect((await call(dir, { action: "discard", paths: ["fresh"], scope: "untracked" })).ok).toBe(true);
    await expect(access(join(dir, "fresh", "nested.txt"))).rejects.toThrow();
  });
});

describe("commit", () => {
  it("commits the index with the given message", async () => {
    const dir = await repo();
    await write(dir, "a.txt", "one\n");
    await call(dir, { action: "stage", paths: ["a.txt"] });
    const reply = await call(dir, { action: "commit", message: "add a", amend: false });
    expect(reply.ok).toBe(true);

    expect((await git(dir, ["log", "-1", "--pretty=%s"])).trim()).toBe("add a");
    const status = statusOf(await call(dir, { action: "status" }));
    expect(status.files).toEqual([]);
  });

  it("amends the previous commit instead of adding one", async () => {
    const dir = await repo();
    await write(dir, "a.txt", "one\n");
    await call(dir, { action: "stage", paths: ["a.txt"] });
    await call(dir, { action: "commit", message: "first", amend: false });
    const before = await commitCount(dir);

    await write(dir, "b.txt", "two\n");
    await call(dir, { action: "stage", paths: ["b.txt"] });
    expect((await call(dir, { action: "commit", message: "first, better", amend: true })).ok).toBe(true);

    expect(await commitCount(dir)).toBe(before);
    expect((await git(dir, ["log", "-1", "--pretty=%s"])).trim()).toBe("first, better");
    expect((await git(dir, ["show", "--name-only", "--pretty="])).trim().split("\n")).toContain("b.txt");
  });

  it("refuses an empty message", async () => {
    const dir = await repo();
    await write(dir, "a.txt", "one\n");
    await call(dir, { action: "stage", paths: ["a.txt"] });
    const reply = await call(dir, { action: "commit", message: "  \n", amend: false });
    expect(errorOf(reply).code).toBe("invalid-request");
  });
});

describe("write queue", () => {
  it("serializes two overlapping writes instead of failing on the index lock", async () => {
    const dir = await repo();
    await write(dir, "a.txt", "one\n");
    await write(dir, "b.txt", "two\n");

    const [first, second] = await Promise.all([
      call(dir, { action: "stage", paths: ["a.txt"] }),
      call(dir, { action: "stage", paths: ["b.txt"] }),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const status = statusOf(await call(dir, { action: "status" }));
    expect(status.files.map((entry) => entry.path).sort()).toEqual(["a.txt", "b.txt"]);
  });
});