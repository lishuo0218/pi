// POST /api/git dispatch. Every action resolves the repository first (so a
// request in a non-repo directory fails with a setup state the page can show),
// validates its own fields in validate.ts, runs one git command, and returns a
// tagged result. Writes go through the per-repository queue in write.ts.
import { applyHunk, readCommitDiff, readFileDiff } from "./diff.ts";
import { readLog } from "./log.ts";
import { draftCommitMessage } from "./message.ts";
import { fetchRemote, pull, push } from "./remote.ts";
import { resolveRepo } from "./repo.ts";
import { readStatus } from "./status.ts";
import { gitError, type GitResult } from "./types.ts";
import { parseRequest } from "./validate.ts";
import { serializeWrite, writeAction } from "./write.ts";

/** Run one validated git action in the attached session's working directory. */
export async function handleGit(body: unknown, cwd: string, piPath: string): Promise<GitResult> {
  const request = parseRequest(body);
  if (request === null) return gitError("invalid request", "invalid-request");
  const resolution = await resolveRepo(cwd);
  if (resolution.kind === "error") return gitError(resolution.error, resolution.code);
  const repo = resolution.repo;
  switch (request.action) {
    case "status":
      return readStatus(repo);
    case "fileDiff":
      return readFileDiff(repo, request.path, request.side, request.context);
    case "commitDiff":
      return readCommitDiff(repo, request.sha);
    case "log":
      return readLog(repo, request.limit, request.skip);
    // The draft runs pi with no tools, so it cannot touch the index: no queue.
    case "draftMessage":
      return draftCommitMessage(repo, piPath);
    // Applying a hunk writes the index or the worktree, so it joins the queue.
    case "hunk":
      return serializeWrite(repo.root, () => applyHunk(repo, request));
    // fetch and push only move refs; pull also writes HEAD and the worktree, so
    // it alone joins the write queue.
    case "fetch":
      return fetchRemote(repo);
    case "pull":
      return serializeWrite(repo.root, () => pull(repo));
    case "push":
      return push(repo);
    case "stage":
    case "unstage":
    case "discard":
    case "commit":
      return writeAction(repo, request);
  }
}