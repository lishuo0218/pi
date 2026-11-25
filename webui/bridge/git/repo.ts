// Repository resolution for the Git view: the top level every path is relative
// to, the git directory the file watcher follows, and the multi-step operation
// the repository is paused in. Resolving the top level matters because the pi
// working directory may be a subdirectory of the repository: running git there
// would report paths relative to that subdirectory, and hunk patches are only
// applicable from the top level.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { errorText, runGit, succeeded } from "./exec.ts";
import type { GitErrorCode, GitOperation } from "./types.ts";

export type Repo = { root: string; gitDir: string };

export type RepoResolution =
  | { kind: "ok"; repo: Repo }
  | { kind: "error"; error: string; code: GitErrorCode };

/** Read a git state file, treating "absent" as null. */
async function readState(path: string): Promise<string | null> {
  try {
    return (await readFile(path, "utf-8")).trim();
  } catch {
    return null;
  }
}

/** Positive integer from a git state file, or null. */
async function readCount(path: string): Promise<number | null> {
  const text = await readState(path);
  if (text === null) return null;
  const value = Number(text);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/** Entries left in `.git/sequencer/todo`, which drives a multi-commit pick. */
async function readTodoCount(gitDir: string): Promise<number | null> {
  const text = await readState(join(gitDir, "sequencer", "todo"));
  if (text === null) return null;
  return text.split("\n").filter((line) => line !== "" && !line.startsWith("#")).length;
}

/**
 * The operation the repository is paused in, or null. Rebase wins over the rest:
 * a rebase that stops on a conflict leaves a merge-like state in some versions.
 */
async function readOperation(gitDir: string): Promise<GitOperation | null> {
  const rebaseMerge = await readCount(join(gitDir, "rebase-merge", "msgnum"));
  if (rebaseMerge !== null) {
    const headName = await readState(join(gitDir, "rebase-merge", "head-name"));
    return {
      kind: "rebase",
      step: rebaseMerge,
      total: await readCount(join(gitDir, "rebase-merge", "end")),
      onto: headName === null ? null : headName.replace(/^refs\/heads\//, ""),
    };
  }
  const rebaseApply = await readCount(join(gitDir, "rebase-apply", "next"));
  if (rebaseApply !== null) {
    const headName = await readState(join(gitDir, "rebase-apply", "head-name"));
    return {
      kind: "rebase",
      step: rebaseApply,
      total: await readCount(join(gitDir, "rebase-apply", "last")),
      onto: headName === null ? null : headName.replace(/^refs\/heads\//, ""),
    };
  }
  if ((await readState(join(gitDir, "MERGE_HEAD"))) !== null) return { kind: "merge" };
  if ((await readState(join(gitDir, "CHERRY_PICK_HEAD"))) !== null) {
    return { kind: "cherryPick", remaining: await readTodoCount(gitDir) };
  }
  if ((await readState(join(gitDir, "REVERT_HEAD"))) !== null) {
    return { kind: "revert", remaining: await readTodoCount(gitDir) };
  }
  if ((await readState(join(gitDir, "BISECT_LOG"))) !== null) return { kind: "bisect" };
  return null;
}

/** Resolve the repository containing `cwd`, or why there is none. */
export async function resolveRepo(cwd: string): Promise<RepoResolution> {
  const run = await runGit(cwd, ["rev-parse", "--show-toplevel", "--absolute-git-dir"]);
  if (!succeeded(run)) {
    if (run.spawnError !== null) return { kind: "error", error: errorText(run, "git"), code: "git-missing" };
    return { kind: "error", error: "not a git repository", code: "not-a-repo" };
  }
  const [root = "", gitDir = ""] = run.stdout.split("\n").map((line) => line.trim());
  if (root === "" || gitDir === "") {
    return { kind: "error", error: "not a git repository", code: "not-a-repo" };
  }
  return { kind: "ok", repo: { root, gitDir } };
}

/** The paused operation of a resolved repository, if any. */
export function operationOf(repo: Repo): Promise<GitOperation | null> {
  return readOperation(repo.gitDir);
}
