// Patches for the Git view: a file's worktree or index diff, one commit's diff,
// and applying one hunk of a file patch back into the index or the worktree.
// The page only sends a hunk index; the patch itself is recomputed here so a
// stale or hostile body can never apply lines the bridge did not see.
import { readFile } from "node:fs/promises";
import { scopePath } from "../cwd-path.ts";
import { errorText, OUTPUT_CAP, runGit, succeeded } from "./exec.ts";
import type { Repo } from "./repo.ts";
import type { GitContext, GitDiff, GitErrorCode, GitResult, GitSide } from "./types.ts";

/** git's own words for "this patch has no text hunks". */
const BINARY_RE = /^(Binary files .* differ|GIT binary patch)$/m;
const HUNK_RE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;

function asDiff(text: string, truncated: boolean, binary: boolean): GitDiff {
  return { text, truncated, binary: binary || BINARY_RE.test(text) };
}

/** Diff arguments shared by every read, so a patch stays applicable. */
const DIFF_ARGS = ["--no-color", "--no-ext-diff", "--no-textconv"];

/**
 * Context lines around each change. `full` is bounded by git's own limit and
 * the output cap; it exists so the page can fold the unchanged gaps itself.
 */
function contextArgs(context: GitContext): string[] {
  return [context === "full" ? "--unified=200000" : "--unified=3"];
}

/** Render an untracked file as a new-file unified diff (git has no index entry). */
function newFileDiff(path: string, text: string): string {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join("\n");
}

/** Is `path` untracked (so a worktree diff must be synthesized from the file)? */
async function isUntracked(repo: Repo, path: string): Promise<boolean> {
  const run = await runGit(repo.root, ["ls-files", "--others", "--exclude-standard", "-z", "--", path]);
  return succeeded(run) && run.stdout.split("\0").includes(path);
}

/** A file's diff, with untracked worktree files synthesized as new files. */
export async function filePatch(
  repo: Repo,
  path: string,
  side: GitSide,
  context: GitContext,
): Promise<{ text: string; truncated: boolean; binary: boolean } | { error: string; code: GitErrorCode }> {
  if (side === "worktree" && (await isUntracked(repo, path))) {
    const scoped = await scopePath(repo.root, path);
    if (scoped.kind === "error") return { error: scoped.error, code: "invalid-request" };
    let raw: Buffer;
    try {
      raw = await readFile(scoped.path);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error), code: "failed" };
    }
    const truncated = raw.length > OUTPUT_CAP;
    // A NUL in the first block is git's own binary heuristic: no text diff.
    if (raw.subarray(0, 8000).includes(0)) return { text: "", truncated: false, binary: true };
    const text = raw.subarray(0, OUTPUT_CAP).toString("utf-8").replaceAll("\r\n", "\n");
    return { text: newFileDiff(path, text), truncated, binary: false };
  }
  const args = ["diff", ...DIFF_ARGS, ...contextArgs(context)];
  if (side === "index") args.push("--cached");
  // `--` guards a path that looks like an option.
  args.push("--", path);
  const run = await runGit(repo.root, args);
  if (!succeeded(run)) return { error: errorText(run, "git diff"), code: "failed" };
  return { text: run.stdout, truncated: run.truncated, binary: false };
}

/** One changed file's patch, as the page renders it. */
export async function readFileDiff(
  repo: Repo,
  path: string,
  side: GitSide,
  context: GitContext,
): Promise<GitResult> {
  const patch = await filePatch(repo, path, side, context);
  if ("error" in patch) return { ok: false, error: patch.error, code: patch.code };
  return { ok: true, action: "diff", diff: asDiff(patch.text, patch.truncated, patch.binary) };
}

/** One commit's patch. */
export async function readCommitDiff(repo: Repo, sha: string): Promise<GitResult> {
  const run = await runGit(repo.root, ["show", ...DIFF_ARGS, "--unified=3", "--patch", "--format=", sha]);
  if (!succeeded(run)) return { ok: false, error: errorText(run, "git show"), code: "failed" };
  return { ok: true, action: "diff", diff: asDiff(run.stdout, run.truncated, false) };
}

/** One file's patch inside a commit; `--` guards a path that looks like an option. */
export async function readCommitFileDiff(repo: Repo, sha: string, path: string): Promise<GitResult> {
  const run = await runGit(repo.root, [
    "show",
    ...DIFF_ARGS,
    "--unified=3",
    "--patch",
    "--format=",
    sha,
    "--",
    path,
  ]);
  if (!succeeded(run)) return { ok: false, error: errorText(run, "git show"), code: "failed" };
  return { ok: true, action: "diff", diff: asDiff(run.stdout, run.truncated, false) };
}

/**
 * Split a one-file patch into its header and its hunks. Null when there is no
 * hunk to apply (binary patch, or no diff at all).
 */
export function splitHunks(text: string): { header: string[]; hunks: string[][] } | null {
  const header: string[] = [];
  const hunks: string[][] = [];
  let current: string[] | null = null;
  for (const line of text.split("\n")) {
    if (HUNK_RE.test(line)) {
      current = [line];
      hunks.push(current);
      continue;
    }
    if (current === null) header.push(line);
    else current.push(line);
  }
  if (hunks.length === 0) return null;
  return { header, hunks };
}

/**
 * Apply one hunk of a file patch. `stage` copies the worktree hunk into the
 * index, `unstage` removes the index hunk, `discard` reverses the worktree
 * hunk. A patch that no longer matches (the file changed since the page read
 * it) fails in git apply and is reported as an error, never partially applied.
 */
export async function applyHunk(
  repo: Repo,
  request: {
    path: string;
    side: GitSide;
    context: GitContext;
    hunk: number;
    op: "stage" | "unstage" | "discard";
  },
): Promise<GitResult> {
  const patch = await filePatch(repo, request.path, request.side, request.context);
  if ("error" in patch) return { ok: false, error: patch.error, code: patch.code };
  if (patch.truncated) return { ok: false, error: "diff 过长，无法按块应用", code: "failed" };
  const split = splitHunks(patch.text);
  const hunk = split?.hunks[request.hunk];
  if (split === null || hunk === undefined) {
    return { ok: false, error: "这个改动块已经不存在，请刷新后重试", code: "failed" };
  }
  const text = `${[...split.header, ...hunk].join("\n")}\n`;
  const args = ["apply"];
  if (request.op === "stage") args.push("--cached");
  if (request.op === "unstage") args.push("--cached", "--reverse");
  if (request.op === "discard") args.push("--reverse");
  const run = await runGit(repo.root, args, { input: text });
  if (!succeeded(run)) {
    return { ok: false, error: errorText(run, "git apply"), code: "failed" };
  }
  return { ok: true, action: "done", output: run.stdout.trim() };
}