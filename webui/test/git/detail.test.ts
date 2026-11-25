// Commit detail and ref discovery against real repositories: the file list with
// its line counts, one file's patch, merge commits without a file list, and the
// branch/remote/tag names the history filter lists.
import { afterEach, describe, expect, it } from "vitest";
import { call, cleanupAll, diffOf, git, makeDir, makeRepo, write, type Fixture } from "./helpers.ts";

const fixtures: Fixture[] = [];
afterEach(() => cleanupAll(fixtures));

function detailOf(reply: Awaited<ReturnType<typeof call>>) {
  if (!reply.ok || reply.action !== "detail") throw new Error(`expected detail, got ${JSON.stringify(reply)}`);
  return reply.detail;
}

function refsOf(reply: Awaited<ReturnType<typeof call>>) {
  if (!reply.ok || reply.action !== "refs") throw new Error(`expected refs, got ${JSON.stringify(reply)}`);
  return reply.refs;
}

/** A repo whose second commit changes two files by a known amount. */
async function repoWithChanges(): Promise<{ dir: string; sha: string }> {
  const fixture = await makeRepo();
  fixtures.push(fixture);
  const dir = fixture.dir;
  await write(dir, "a.txt", "one\ntwo\nthree\n");
  await write(dir, "dir/b.txt", "b\n");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "add files"]);
  await write(dir, "a.txt", "one\nTWO\nthree\nfour\n");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "change a"]);
  const sha = (await git(dir, ["rev-parse", "HEAD"])).trim();
  return { dir, sha };
}

describe("commitDetail", () => {
  it("lists the changed files with their line counts", async () => {
    const { dir, sha } = await repoWithChanges();
    const detail = detailOf(await call(dir, { action: "commitDetail", sha }));
    expect(detail.commit.sha).toBe(sha);
    expect(detail.commit.subject).toBe("change a");
    expect(detail.stats).toEqual({ files: 1, add: 2, del: 1 });
    expect(detail.files).toEqual([{ path: "a.txt", add: 2, del: 1 }]);
  });

  it("lists a binary file without line counts", async () => {
    const fixture = await makeRepo();
    fixtures.push(fixture);
    const dir = fixture.dir;
    await write(dir, "blob.bin", "\u0000\u0001binary\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "-m", "binary"]);
    const sha = (await git(dir, ["rev-parse", "HEAD"])).trim();
    const detail = detailOf(await call(dir, { action: "commitDetail", sha }));
    expect(detail.files).toEqual([{ path: "blob.bin", add: null, del: null }]);
  });

  it("lists no files for a merge commit", async () => {
    const fixture = await makeRepo();
    fixtures.push(fixture);
    const dir = fixture.dir;
    await write(dir, "a.txt", "main\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "-m", "main"]);
    await git(dir, ["checkout", "-q", "-b", "side"]);
    await write(dir, "b.txt", "side\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "-m", "side"]);
    await git(dir, ["checkout", "-q", "main"]);
    await git(dir, ["merge", "-q", "--no-ff", "-m", "merge side", "side"]);
    const sha = (await git(dir, ["rev-parse", "HEAD"])).trim();
    const detail = detailOf(await call(dir, { action: "commitDetail", sha }));
    expect(detail.commit.parents).toHaveLength(2);
    expect(detail.files).toEqual([]);
  });

  it("fails for an unknown commit", async () => {
    const { dir } = await repoWithChanges();
    const reply = await call(dir, { action: "commitDetail", sha: "0".repeat(40) });
    expect(reply.ok).toBe(false);
  });
});

describe("commitFileDiff", () => {
  it("patches only the named file", async () => {
    const { dir, sha } = await repoWithChanges();
    const diff = diffOf(await call(dir, { action: "commitFileDiff", sha, path: "a.txt" }));
    expect(diff.text).toContain("+four");
    expect(diff.text).not.toContain("blob.bin");
  });
});

describe("refs", () => {
  it("lists branches, remote-tracking refs and tags", async () => {
    const fixture = await makeRepo();
    fixtures.push(fixture);
    const dir = fixture.dir;
    const remote = await makeDir();
    fixtures.push(remote);
    await git(remote.dir, ["init", "-q", "--bare", "-b", "main"]);
    await git(dir, ["remote", "add", "origin", remote.dir]);
    await git(dir, ["push", "-q", "-u", "origin", "main"]);
    await git(dir, ["branch", "feature/x"]);
    await git(dir, ["tag", "v1"]);
    expect(refsOf(await call(dir, { action: "refs" }))).toEqual({
      local: ["feature/x", "main"],
      remote: ["origin/main"],
      tag: ["v1"],
    });
  });

  it("does not list origin/HEAD as a walk target", async () => {
    const fixture = await makeRepo();
    fixtures.push(fixture);
    const dir = fixture.dir;
    const remote = await makeDir();
    fixtures.push(remote);
    await git(remote.dir, ["init", "-q", "--bare", "-b", "main"]);
    await git(dir, ["remote", "add", "origin", remote.dir]);
    await git(dir, ["push", "-q", "-u", "origin", "main"]);
    await git(dir, ["remote", "set-head", "origin", "main"]);
    expect(refsOf(await call(dir, { action: "refs" })).remote).toEqual(["origin/main"]);
  });
});
