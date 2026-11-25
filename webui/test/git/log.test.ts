// History paging against real repositories: newest first, `hasMore` on a full
// page, `skip` continuing where the last page ended, and an unborn branch as an
// empty history rather than an error.
import { afterEach, describe, expect, it } from "vitest";
import { call, cleanupAll, git, makeRepo, write, type Fixture } from "./helpers.ts";

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