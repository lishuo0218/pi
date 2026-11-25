// Commit history for the Git view: one page of `git log`, parsed from a
// record-separated format so subjects may contain anything. An unborn branch
// has no commits yet, which is an empty history rather than an error.
import { errorText, runGit, succeeded } from "./exec.ts";
import type { Repo } from "./repo.ts";
import type { GitCommit, GitResult } from "./types.ts";

/** Fields of one commit, separated by US (0x1f); commits by RS (0x1e). */
const FORMAT = "%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1e";

/** One page of history, newest first, with `hasMore` for the next request. */
export async function readLog(repo: Repo, limit: number, skip: number): Promise<GitResult> {
  const run = await runGit(repo.root, [
    "log",
    `--skip=${skip}`,
    `-n`,
    String(limit + 1),
    "--date=format:%Y-%m-%d %H:%M",
    `--pretty=format:${FORMAT}`,
  ]);
  if (!succeeded(run)) {
    if (run.stderr.includes("does not have any commits") || run.stderr.includes("unknown revision")) {
      return { ok: true, action: "commits", commits: [], hasMore: false };
    }
    return { ok: false, error: errorText(run, "git log"), code: "failed" };
  }
  const commits: GitCommit[] = [];
  for (const record of run.stdout.split("\x1e")) {
    const line = record.replace(/^\n/, "");
    if (line === "") continue;
    const [sha, short, author, date, ...subject] = line.split("\x1f");
    if (!sha || !short || !author || !date) continue;
    commits.push({ sha, short, author, date, subject: subject.join("\x1f") });
  }
  const hasMore = commits.length > limit;
  return { ok: true, action: "commits", commits: hasMore ? commits.slice(0, limit) : commits, hasMore };
}