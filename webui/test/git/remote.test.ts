// Network actions against a local bare repository: fetch refreshes the remote
// ref, push publishes commits, pull only fast-forwards, and a branch without an
// upstream says so instead of guessing a remote.
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { call, cleanupAll, commitAll, errorOf, git, lines, makeDir, makeRepo, statusOf, write, type Fixture } from "./helpers.ts";

const fixtures: Fixture[] = [];

afterAll(() => cleanupAll(fixtures));

/** A bare repository to act as a file remote, and a clone that tracks it. */
async function withRemote(): Promise<{ bare: Fixture; repo: Fixture; clone: Fixture }> {
  const bare = await makeDir();
  fixtures.push(bare);
  await git(bare.dir, ["init", "-q", "--bare", "-b", "main"]);
  const repo = await makeRepo();
  fixtures.push(repo);
  await write(repo.dir, "a.txt", "one\n");
  await commitAll(repo.dir, "add a");
  await git(repo.dir, ["remote", "add", "origin", bare.dir]);
  await git(repo.dir, ["push", "-q", "-u", "origin", "main"]);
  const clone = await makeDir();
  fixtures.push(clone);
  await git(clone.dir, ["clone", "-q", bare.dir, "."]);
  return { bare, repo, clone };
}

describe("fetch", () => {
  it("brings a pushed commit into the remote-tracking ref", async () => {
    const { repo, clone } = await withRemote();
    await write(repo.dir, "b.txt", "two\n");
    await commitAll(repo.dir, "add b");
    await git(repo.dir, ["push", "-q"]);
    expect(statusOf(await call(clone.dir, { action: "status" })).behind).toBe(0);

    const reply = await call(clone.dir, { action: "fetch" });
    expect(reply.ok).toBe(true);
    expect(statusOf(await call(clone.dir, { action: "status" })).behind).toBe(1);
  });

  it("is a no-op in a repository without remotes", async () => {
    const repo = await makeRepo();
    fixtures.push(repo);
    // Modern git treats it as nothing to do rather than an error.
    expect(await call(repo.dir, { action: "fetch" })).toEqual({ ok: true, action: "done", output: "" });
  });

  it("reports git's own reason when the remote is unreachable", async () => {
    const repo = await makeRepo();
    fixtures.push(repo);
    await git(repo.dir, ["remote", "add", "origin", join(repo.dir, "missing.git")]);
    const failure = errorOf(await call(repo.dir, { action: "fetch" }));
    expect(failure.code).toBe("failed");
    expect(failure.error).toMatch(/does not appear to be a git repository|not found/i);
  });
});

describe("push", () => {
  it("publishes the commit and clears ahead", async () => {
    const { bare, repo } = await withRemote();
    await write(repo.dir, "b.txt", "two\n");
    const sha = await commitAll(repo.dir, "add b");
    expect(statusOf(await call(repo.dir, { action: "status" })).ahead).toBe(1);

    const reply = await call(repo.dir, { action: "push" });
    expect(reply).toMatchObject({ ok: true, action: "done" });
    expect((await git(bare.dir, ["rev-parse", "main"])).trim()).toBe(sha);
    expect(statusOf(await call(repo.dir, { action: "status" })).ahead).toBe(0);
  });

  it("names the command that sets an upstream instead of pushing anywhere", async () => {
    const bare = await makeDir();
    fixtures.push(bare);
    await git(bare.dir, ["init", "-q", "--bare", "-b", "main"]);
    const repo = await makeRepo();
    fixtures.push(repo);
    await git(repo.dir, ["remote", "add", "origin", bare.dir]);

    const failure = errorOf(await call(repo.dir, { action: "push" }));
    expect(failure.code).toBe("failed");
    expect(failure.error).toContain("git push -u origin main");
    // Nothing reached the remote.
    expect(errorOf(await call(repo.dir, { action: "pull" })).error).toContain("git push -u origin main");
  });

  it("refuses in a detached HEAD", async () => {
    const { repo } = await withRemote();
    await git(repo.dir, ["checkout", "-q", "--detach", "HEAD"]);
    expect(errorOf(await call(repo.dir, { action: "push" })).error).toContain("游离 HEAD");
  });
});

describe("pull", () => {
  it("fast-forwards onto a commit pushed by another clone", async () => {
    const { repo, clone } = await withRemote();
    await write(repo.dir, "b.txt", lines(3));
    const sha = await commitAll(repo.dir, "add b");
    await git(repo.dir, ["push", "-q"]);

    const reply = await call(clone.dir, { action: "pull" });
    expect(reply).toMatchObject({ ok: true, action: "done" });
    expect((await git(clone.dir, ["rev-parse", "HEAD"])).trim()).toBe(sha);
    expect(statusOf(await call(clone.dir, { action: "status" })).files).toEqual([]);
  });

  it("refuses a diverged branch and keeps the local commit", async () => {
    const { repo, clone } = await withRemote();
    await write(repo.dir, "theirs.txt", "theirs\n");
    await commitAll(repo.dir, "theirs");
    await git(repo.dir, ["push", "-q"]);
    await write(clone.dir, "mine.txt", "mine\n");
    const mine = await commitAll(clone.dir, "mine");

    const failure = errorOf(await call(clone.dir, { action: "pull" }));
    expect(failure.code).toBe("failed");
    expect(failure.error).toContain("fast-forward");
    expect((await git(clone.dir, ["rev-parse", "HEAD"])).trim()).toBe(mine);
  });
});