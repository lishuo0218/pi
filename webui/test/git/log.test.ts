// History paging against real repositories: newest first, `hasMore` on a full
// page, `skip` continuing where the last page ended, and an unborn branch as an
// empty history rather than an error.
import { afterEach, describe, expect, it } from "vitest";
import { call, cleanupAll, git, makeDir, makeRepo, write, type Fixture } from "./helpers.ts";

const fixtures: Fixture[] = [];
afterEach(() => cleanupAll(fixtures));

async function repoWithFourCommits(): Promise<string> {
  const fixture = await makeRepo();
  fixtures.push(fixture);
  const dir = fixture.dir;
  for (const step of [1, 2, 3, 4]) {
    await write(dir, "a.txt", `${step}\n`);
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "-m", `commit ${step}`]);
  }
  return dir;
}

function commitsOf(reply: Awaited<ReturnType<typeof call>>): { subjects: string[]; hasMore: boolean } {
  if (!reply.ok || reply.action !== "commits") throw new Error(`expected commits, got ${JSON.stringify(reply)}`);
  return { subjects: reply.commits.map((commit) => commit.subject), hasMore: reply.hasMore };
}

describe("log", () => {
  it("returns the newest commits first with a full page flagged as more", async () => {
    const dir = await repoWithFourCommits();
    const page = commitsOf(await call(dir, { action: "log", limit: 3, skip: 0 }));
    expect(page.subjects).toEqual(["commit 4", "commit 3", "commit 2"]);
    expect(page.hasMore).toBe(true);
  });

  it("continues from skip and ends without more", async () => {
    const dir = await repoWithFourCommits();
    const page = commitsOf(await call(dir, { action: "log", limit: 3, skip: 3 }));
    expect(page.subjects).toEqual(["commit 1", "init"]);
    expect(page.hasMore).toBe(false);
  });

  it("carries the commit fields the list renders", async () => {
    const dir = await repoWithFourCommits();
    const reply = await call(dir, { action: "log", limit: 1, skip: 0 });
    if (!reply.ok || reply.action !== "commits") throw new Error(JSON.stringify(reply));
    const commit = reply.commits[0];
    expect(commit?.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(commit?.short).toBe(commit?.sha.slice(0, 7));
    expect(commit?.author).toBe("Test");
    expect(commit?.date).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it("treats an unborn branch as empty history", async () => {
    const fixture = await makeRepo();
    fixtures.push(fixture);
    await git(fixture.dir, ["update-ref", "-d", "HEAD"]);
    const page = commitsOf(await call(fixture.dir, { action: "log", limit: 5, skip: 0 }));
    expect(page.subjects).toEqual([]);
    expect(page.hasMore).toBe(false);
  });
});

describe("log refs", () => {
  /** The refs of the newest commit. */
  async function refsOf(dir: string): Promise<unknown> {
    const reply = await call(dir, { action: "log", limit: 1, skip: 0 });
    if (!reply.ok || reply.action !== "commits") throw new Error(JSON.stringify(reply));
    return reply.commits[0]?.refs;
  }

  it("marks the checked-out branch, the remote-tracking ref and the tag", async () => {
    const fixture = await makeRepo();
    fixtures.push(fixture);
    const dir = fixture.dir;
    const remote = await makeDir();
    fixtures.push(remote);
    await git(remote.dir, ["init", "-q", "--bare", "-b", "main"]);
    await git(dir, ["remote", "add", "origin", remote.dir]);
    await git(dir, ["push", "-q", "-u", "origin", "main"]);
    await git(dir, ["tag", "v1"]);

    // git's own order is HEAD's branch, then tags, then remote-tracking refs;
    // the column re-sorts them, so the set is what matters here.
    const refs = await refsOf(dir);
    expect(refs).toEqual(
      expect.arrayContaining([
        { kind: "branch", name: "main" },
        { kind: "remote", name: "origin/main" },
        { kind: "tag", name: "v1" },
      ]),
    );
    expect(Array.isArray(refs) && refs.length).toBe(3);
  });

  it("keeps a local branch with a slash distinct from a remote-tracking ref", async () => {
    const fixture = await makeRepo();
    fixtures.push(fixture);
    const dir = fixture.dir;
    await git(dir, ["branch", "feature/x"]);
    expect(await refsOf(dir)).toEqual([
      { kind: "branch", name: "main" },
      { kind: "branch", name: "feature/x" },
    ]);
  });

  it("has no refs on a commit nothing points at", async () => {
    const fixture = await makeRepo();
    fixtures.push(fixture);
    const dir = fixture.dir;
    await write(dir, "a.txt", "one\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "-m", "second"]);
    expect(await refsOf(dir)).toEqual([{ kind: "branch", name: "main" }]);
    const reply = await call(dir, { action: "log", limit: 2, skip: 0 });
    if (!reply.ok || reply.action !== "commits") throw new Error(JSON.stringify(reply));
    expect(reply.commits[1]?.refs).toEqual([]);
  });
});