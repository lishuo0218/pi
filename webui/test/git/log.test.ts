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

  it("carries the parent shas, none for the root commit", async () => {
    const dir = await repoWithFourCommits();
    const reply = await call(dir, { action: "log", limit: 10, skip: 0 });
    if (!reply.ok || reply.action !== "commits") throw new Error(JSON.stringify(reply));
    const [head, second, , , root] = reply.commits;
    expect(head?.parents).toEqual([second?.sha]);
    expect(root?.parents).toEqual([]);
  });
});

describe("log scope", () => {
  /** A repo whose main and side branches each have their own commit. */
  async function repoWithTwoBranches(): Promise<string> {
    const fixture = await makeRepo();
    fixtures.push(fixture);
    const dir = fixture.dir;
    // Branch first, so each side has a commit the other walk must not reach.
    await git(dir, ["checkout", "-q", "-b", "side"]);
    await write(dir, "b.txt", "side\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "-m", "side work"]);
    await git(dir, ["checkout", "-q", "main"]);
    await write(dir, "a.txt", "main\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "-m", "main work"]);
    return dir;
  }

  it("walks the given ref instead of HEAD", async () => {
    const dir = await repoWithTwoBranches();
    const page = commitsOf(
      await call(dir, { action: "log", limit: 5, skip: 0, rev: "refs/heads/side", all: false, query: null }),
    );
    expect(page.subjects).toEqual(["side work", "init"]);
  });

  it("walks every ref when asked for all", async () => {
    const dir = await repoWithTwoBranches();
    const page = commitsOf(
      await call(dir, { action: "log", limit: 5, skip: 0, rev: null, all: true, query: null }),
    );
    // Git's graph order is not asserted here; both branches' commits must show.
    expect(page.subjects).toEqual(expect.arrayContaining(["side work", "main work", "init"]));
  });
});

describe("log order", () => {
  it("lists a parent after its child when a tag starts a second walk", async () => {
    const fixture = await makeRepo();
    fixtures.push(fixture);
    const dir = fixture.dir;
    // Same committer date on purpose: with `--all` the tag is a second starting
    // point, and without an explicit order git prints the tagged release before
    // the commit built on top of it. The lane layout draws one line down per
    // parent, so that order would leave a lane that never reaches a commit.
    const env = { ...process.env, GIT_AUTHOR_DATE: "2026-01-01T00:00:00", GIT_COMMITTER_DATE: "2026-01-01T00:00:00" };
    await write(dir, "a.txt", "release\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "-m", "release"], env);
    await git(dir, ["tag", "v1"], env);
    await write(dir, "b.txt", "child\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "-m", "child of release"], env);
    await write(dir, "c.txt", "later\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "-m", "later"], env);

    const page = commitsOf(await call(dir, { action: "log", limit: 10, skip: 0, rev: null, all: true, query: null }));
    expect(page.subjects).toEqual(["later", "child of release", "release", "init"]);
  });
});

describe("log search", () => {
  /** A repo with messages and authors the search must tell apart. */
  async function repoWithSearchableCommits(): Promise<string> {
    const fixture = await makeRepo();
    fixtures.push(fixture);
    const dir = fixture.dir;
    await write(dir, "a.txt", "one\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "-m", "Fix (a+b) handling"]);
    await write(dir, "b.txt", "two\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "-m", "unrelated", "--author", "Alice <alice@example.com>"]);
    return dir;
  }

  it("matches the message literally and case-insensitively", async () => {
    const dir = await repoWithSearchableCommits();
    const page = commitsOf(
      await call(dir, { action: "log", limit: 10, skip: 0, rev: null, all: false, query: "fix (A+B)" }),
    );
    expect(page.subjects).toEqual(["Fix (a+b) handling"]);
  });

  it("does not read the query as a regular expression", async () => {
    const dir = await repoWithSearchableCommits();
    const page = commitsOf(
      await call(dir, { action: "log", limit: 10, skip: 0, rev: null, all: false, query: "Fix.*handling" }),
    );
    expect(page.subjects).toEqual([]);
  });

  it("matches the author as well as the message", async () => {
    const dir = await repoWithSearchableCommits();
    const page = commitsOf(
      await call(dir, { action: "log", limit: 10, skip: 0, rev: null, all: false, query: "alice" }),
    );
    expect(page.subjects).toEqual(["unrelated"]);
  });

  it("finds a commit by abbreviated sha", async () => {
    const dir = await repoWithSearchableCommits();
    const short = (await git(dir, ["rev-parse", "--short=8", "HEAD~1"])).trim();
    const page = commitsOf(
      await call(dir, { action: "log", limit: 10, skip: 0, rev: null, all: false, query: short }),
    );
    expect(page.subjects).toEqual(["Fix (a+b) handling"]);
  });

  it("pages a search from its own start and ends on the last match", async () => {
    const dir = await repoWithSearchableCommits();
    const first = commitsOf(
      await call(dir, { action: "log", limit: 1, skip: 0, rev: null, all: false, query: "i" }),
    );
    expect(first.subjects).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    const second = commitsOf(
      await call(dir, { action: "log", limit: 5, skip: 1, rev: null, all: false, query: "i" }),
    );
    expect(second.hasMore).toBe(false);
    expect(first.subjects.concat(second.subjects)).toEqual(
      expect.arrayContaining(["Fix (a+b) handling", "unrelated", "init"]),
    );
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