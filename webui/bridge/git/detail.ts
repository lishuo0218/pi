// Commit detail for the Git view's right pane: the ref names the history filter
// offers, and one commit's parents, line counts and changed files. The file list
// is what lets the pane open one file's patch instead of the whole commit.
import { errorText, runGit, succeeded } from "./exec.ts";
import { readCommit } from "./log.ts";
import type { Repo } from "./repo.ts";
import { parseNumstat } from "./status.ts";
import type { GitCommitFile, GitResult, GitStats } from "./types.ts";

/** Short names of the refs under one glob, skipping symbolic refs like `origin/HEAD`. */
async function refNames(repo: Repo, glob: string): Promise<string[]> {
  const run = await runGit(repo.root, ["for-each-ref", "--format=%(refname:short)%1f%(symref)", glob]);
  if (!succeeded(run)) return [];
  return run.stdout
    .split("\n")
    .map((line) => line.split("\x1f"))
    .filter(([name, symref]) => name !== undefined && name !== "" && (symref ?? "") === "")
    .map(([name]) => name ?? "");
}

/** Every branch, remote-tracking branch and tag the filter can start a walk at. */
export async function readRefs(repo: Repo): Promise<GitResult> {
  const [local, remote, tag] = await Promise.all([
    refNames(repo, "refs/heads"),
    refNames(repo, "refs/remotes"),
    refNames(repo, "refs/tags"),
  ]);
  return {
    ok: true,
    action: "refs",
    // `origin/HEAD` is a symbolic default-branch pointer, not a walk target; it
    // is already gone above, so no further filtering is needed here.
    refs: { local, remote, tag },
  };
}

/**
 * One commit with its numstat file list. A merge commit shows no files: git's
 * plain `show` compares it with no single parent, and picking one would be a
 * silent choice the pane should not make for the user.
 */
export async function readCommitDetail(repo: Repo, sha: string): Promise<GitResult> {
  const commit = await readCommit(repo, sha);
  if (commit === null) return { ok: false, error: `找不到提交 ${sha}`, code: "failed" };
  // No single-parent base to diff against, so no file list either.
  if (commit.parents.length > 1) {
    return { ok: true, action: "detail", detail: { commit, stats: { files: 0, add: 0, del: 0 }, files: [] } };
  }

  const run = await runGit(repo.root, [
    "show",
    "--numstat",
    "-z",
    "--format=",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    sha,
  ]);
  if (!succeeded(run)) return { ok: false, error: errorText(run, "git show --numstat"), code: "failed" };

  const files: GitCommitFile[] = [];
  const stats: GitStats = { files: 0, add: 0, del: 0 };
  for (const [path, stat] of parseNumstat(run.stdout)) {
    files.push({ path, add: stat.add, del: stat.del });
    stats.files += 1;
    stats.add += stat.add ?? 0;
    stats.del += stat.del ?? 0;
  }
  return { ok: true, action: "detail", detail: { commit, stats, files } };
}