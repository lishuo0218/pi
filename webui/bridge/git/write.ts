// Write actions of the Git view (stage, unstage, discard, commit) and the queue
// that serializes them. git takes an index lock per write, so two writes in the
// same repository must not overlap: the second would fail with "index.lock
// exists" for no user-visible reason. Reads are not queued.
import { errorCode, errorText, runGit, succeeded } from "./exec.ts";
import type { Repo } from "./repo.ts";
import type { GitRequest, GitResult } from "./types.ts";

/** Pending writes per repository root; each value is the queue's tail. */
const queues = new Map<string, Promise<void>>();

/** Run `task` after every earlier write of the same repository has settled. */
export function serializeWrite<T>(root: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(root) ?? Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(root, tail);
  void tail.then(() => {
    if (queues.get(root) === tail) queues.delete(root);
  });
  return run;
}

/** Finish a write: git's own summary on success, its first error line otherwise. */
function finish(run: Awaited<ReturnType<typeof runGit>>, label: string): GitResult {
  if (!succeeded(run)) return { ok: false, error: errorText(run, label), code: errorCode(run) };
  return { ok: true, action: "done", output: run.stdout.trim() || run.stderr.trim() };
}

async function unstage(repo: Repo, paths: string[]): Promise<GitResult> {
  // An unborn branch has no HEAD to reset to, so the entries are removed instead.
  const head = await runGit(repo.root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (succeeded(head)) return finish(await runGit(repo.root, ["reset", "-q", "HEAD", "--", ...paths]), "git reset");
  return finish(await runGit(repo.root, ["rm", "--cached", "-q", "-r", "--", ...paths]), "git rm --cached");
}

/** Apply one write action, serialized against the other writes of its repo. */
export function writeAction(
  repo: Repo,
  request: Extract<GitRequest, { action: "stage" | "unstage" | "discard" | "commit" }>,
): Promise<GitResult> {
  return serializeWrite(repo.root, async () => {
    switch (request.action) {
      case "stage":
        return finish(await runGit(repo.root, ["add", "--", ...request.paths]), "git add");
      case "unstage":
        return unstage(repo, request.paths);
      case "discard":
        if (request.scope === "untracked") {
          return finish(await runGit(repo.root, ["clean", "-f", "-d", "-q", "--", ...request.paths]), "git clean");
        }
        return finish(
          await runGit(
            repo.root,
            request.scope === "all"
              ? ["restore", "--staged", "--worktree", "--", ...request.paths]
              : ["restore", "--worktree", "--", ...request.paths],
          ),
          "git restore",
        );
      case "commit": {
        if (request.message.trim() === "") {
          return { ok: false, error: "提交信息为空", code: "invalid-request" };
        }
        const args = ["commit", "-m", request.message];
        if (request.amend) args.push("--amend");
        return finish(await runGit(repo.root, args), "git commit");
      }
    }
  });
}