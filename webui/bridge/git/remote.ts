// Network operations of the Git view: fetch, pull --ff-only and push. They run
// with the network budget instead of the local one, and git is started with
// GIT_TERMINAL_PROMPT=0, so a missing credential fails with a message instead of
// blocking the bridge on a password nobody can type.
import { errorCode, errorText, NETWORK_TIMEOUT_MS, runGit, succeeded } from "./exec.ts";
import type { Repo } from "./repo.ts";
import type { GitResult } from "./types.ts";

/**
 * Finish a network command. git prints the ref summary last ("abc..def  main ->
 * main", "Everything up-to-date"), and that is the one line worth a notice bar,
 * so the last non-empty line is taken instead of the first.
 */
function finish(run: Awaited<ReturnType<typeof runGit>>, label: string): GitResult {
  if (!succeeded(run)) return { ok: false, error: errorText(run, label), code: errorCode(run) };
  const lines = `${run.stdout}\n${run.stderr}`
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return { ok: true, action: "done", output: lines.at(-1) ?? "" };
}

/** The checked-out branch, or null in a detached HEAD where nothing can be pushed. */
async function currentBranch(repo: Repo): Promise<string | null> {
  const head = await runGit(repo.root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!succeeded(head)) return null;
  const branch = head.stdout.trim();
  return branch === "" || branch === "HEAD" ? null : branch;
}

/** The upstream ref of the current branch (`origin/main`), or null when unset. */
async function upstreamOf(repo: Repo): Promise<string | null> {
  const upstream = await runGit(repo.root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (!succeeded(upstream)) return null;
  const ref = upstream.stdout.trim();
  return ref === "" ? null : ref;
}

/**
 * Why push and pull cannot run here, or null when they can. Both need a branch
 * that tracks a remote: `git push` with no upstream has nothing to push to, and
 * the message tells the user the one command that fixes that.
 */
async function trackingProblem(repo: Repo, action: string): Promise<string | null> {
  const branch = await currentBranch(repo);
  if (branch === null) return `游离 HEAD 状态无法${action}，先切换到一个分支`;
  const upstream = await upstreamOf(repo);
  if (upstream === null) return `当前分支没有上游，先在终端执行 git push -u origin ${branch}（或 git branch -u origin/${branch}）`;
  return null;
}

/** `git fetch --prune`: refresh remote-tracking refs so ahead/behind stays true. */
export async function fetchRemote(repo: Repo): Promise<GitResult> {
  return finish(await runGit(repo.root, ["fetch", "--prune"], { timeoutMs: NETWORK_TIMEOUT_MS }), "git fetch");
}

/** `git pull --ff-only`: never creates a merge commit, it refuses instead. */
export async function pull(repo: Repo): Promise<GitResult> {
  const problem = await trackingProblem(repo, "拉取");
  if (problem !== null) return { ok: false, error: problem, code: "failed" };
  return finish(await runGit(repo.root, ["pull", "--ff-only"], { timeoutMs: NETWORK_TIMEOUT_MS }), "git pull");
}

export async function push(repo: Repo): Promise<GitResult> {
  const problem = await trackingProblem(repo, "推送");
  if (problem !== null) return { ok: false, error: problem, code: "failed" };
  return finish(await runGit(repo.root, ["push"], { timeoutMs: NETWORK_TIMEOUT_MS }), "git push");
}