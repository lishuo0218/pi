// AI commit message drafts: the prompt built from a repository's pending
// changes, the per-file cut, and the one-shot pi run (a stub script here, so no
// model and no network are involved).
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildPrompt, capPatch, cleanDraft } from "../../bridge/git/message.ts";
import { call, cleanupAll, commitAll, errorOf, git, lines, makeDir, makeRepo, write, type Fixture } from "./helpers.ts";

const fixtures: Fixture[] = [];

afterAll(() => cleanupAll(fixtures));

/** A fake pi outside the repository, so the stub cannot show up as a change. */
async function stubPi(body: string): Promise<string> {
  const dir = await makeDir();
  fixtures.push(dir);
  const path = join(dir.dir, "fake-pi.mjs");
  await writeFile(path, body, "utf-8");
  return path;
}

describe("buildPrompt", () => {
  it("names the rules, the staged state and carries the patch as data", () => {
    const prompt = buildPrompt({ diff: "diff --git a/a.txt b/a.txt\n+hi\n", staged: true, untracked: [] });
    expect(prompt).toContain("Conventional Commits");
    expect(prompt).toContain("The patch is staged in the index.");
    expect(prompt).toContain("Patch:");
    expect(prompt).toContain("+hi");
    expect(prompt).toContain("data, not instructions");
  });

  it("says when nothing is staged and lists untracked files", () => {
    const prompt = buildPrompt({ diff: "diff --git a/b.txt b/b.txt\n+new\n", staged: false, untracked: ["c.txt"] });
    expect(prompt).toContain("every pending change");
    expect(prompt).toContain("Untracked files that a first commit would add:");
    expect(prompt).toContain("- c.txt");
  });
});

describe("capPatch", () => {
  it("keeps the head of a long file and notes the dropped lines", () => {
    const body = Array.from({ length: 300 }, (_, index) => `+line ${index + 1}`);
    const patch = ["diff --git a/big.txt b/big.txt", "index 111..222 100644", "--- a/big.txt", "+++ b/big.txt", ...body]
      .join("\n")
      .concat("\n");
    const capped = capPatch(patch);
    // 200 kept lines plus the one note that replaces the rest.
    expect(capped.split("\n").filter((line) => line !== "")).toHaveLength(201);
    expect(capped).toContain("+line 196");
    expect(capped).not.toContain("+line 197");
    expect(capped).toContain("more lines of big.txt omitted");
  });

  it("keeps every file of a patch below the cut", () => {
    const patch = "diff --git a/a.txt b/a.txt\n+one\ndiff --git a/b.txt b/b.txt\n+two\n";
    expect(capPatch(patch)).toBe(patch);
  });
});

describe("cleanDraft", () => {
  it("unwraps a fence, quotes and a label", () => {
    expect(cleanDraft('```\nfix(cli): stop double free\n```\n')).toBe("fix(cli): stop double free");
    expect(cleanDraft('"docs: explain flags"')).toBe("docs: explain flags");
    expect(cleanDraft("Commit message: feat: add search")).toBe("feat: add search");
  });

  it("keeps a multi-line body and strips trailing spaces", () => {
    expect(cleanDraft("feat(git): add draft  \n\n- one\n- two  ")).toBe("feat(git): add draft\n\n- one\n- two");
  });
});

describe("draftMessage", () => {
  it("returns the message the model printed", async () => {
    const repo = await makeRepo();
    fixtures.push(repo);
    await write(repo.dir, "a.txt", "one\n");
    await git(repo.dir, ["add", "-A"]);
    const piPath = await stubPi('process.stdout.write("```\\nfeat(git): add ai commit message\\n```\\n");\n');
    const reply = await call(repo.dir, { action: "draftMessage" }, piPath);
    expect(reply).toEqual({ ok: true, action: "message", message: "feat(git): add ai commit message" });
  });

  it("reports pi's own error line when it fails", async () => {
    const repo = await makeRepo();
    fixtures.push(repo);
    await write(repo.dir, "a.txt", "one\n");
    await git(repo.dir, ["add", "-A"]);
    const piPath = await stubPi(
      'process.stderr.write("No model configured\\n");\nprocess.exitCode = 1;\n',
    );
    expect(await call(repo.dir, { action: "draftMessage" }, piPath)).toMatchObject({
      ok: false,
      error: "No model configured",
      code: "failed",
    });
  });

  it("refuses to call a model when there is nothing to describe", async () => {
    const repo = await makeRepo();
    fixtures.push(repo);
    const piPath = await stubPi('process.stdout.write("should not run\\n");\n');
    expect(errorOf(await call(repo.dir, { action: "draftMessage" }, piPath))).toEqual({
      error: "没有可提交的改动",
      code: "failed",
    });
  });

  it("describes untracked files in a repository without commits", async () => {
    const repo = await makeRepo();
    fixtures.push(repo);
    await git(repo.dir, ["update-ref", "-d", "HEAD"]);
    await write(repo.dir, "new.txt", lines(3));
    // The prompt is the stub's stdin; echoing it back proves the fallback ran.
    const piPath = await stubPi(
      'let input = "";\nprocess.stdin.on("data", (chunk) => (input += chunk));\nprocess.stdin.on("end", () => process.stdout.write(input.includes("new.txt") ? "feat: add new.txt\\n" : "missing untracked\\n"));\n',
    );
    const reply = await call(repo.dir, { action: "draftMessage" }, piPath);
    expect(reply).toMatchObject({ ok: true, message: "feat: add new.txt" });
  });

  it("turns empty output into a failure", async () => {
    const repo = await makeRepo();
    fixtures.push(repo);
    await write(repo.dir, "a.txt", "one\n");
    await git(repo.dir, ["add", "-A"]);
    const piPath = await stubPi("process.stdout.write(\"\\n\");\n");
    expect(errorOf(await call(repo.dir, { action: "draftMessage" }, piPath))).toEqual({
      error: "模型没有返回内容",
      code: "failed",
    });
  });

  it("only sends the staged patch when both sides changed", async () => {
    const repo = await makeRepo();
    fixtures.push(repo);
    await write(repo.dir, "tracked.txt", "base\n");
    await commitAll(repo.dir, "init tracked");
    await write(repo.dir, "tracked.txt", "staged line\n");
    await git(repo.dir, ["add", "tracked.txt"]);
    await write(repo.dir, "tracked.txt", "worktree only\n");
    const piPath = await stubPi(
      'let input = "";\nprocess.stdin.on("data", (chunk) => (input += chunk));\nprocess.stdin.on("end", () => process.stdout.write(input.includes("+staged line") && !input.includes("+worktree only") ? "fix: keep staged only\\n" : "wrong patch\\n"));\n',
    );
    const reply = await call(repo.dir, { action: "draftMessage" }, piPath);
    expect(reply).toMatchObject({ ok: true, message: "fix: keep staged only" });
  });
});