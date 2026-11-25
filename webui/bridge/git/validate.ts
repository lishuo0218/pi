// Validation of the page's POST /api/git body. This is a trust boundary: every
// field arrives untyped, so each action's fields are checked here and a
// malformed request is refused instead of being run against the repository.
// Paths are repository-relative by contract; an absolute or escaping path is
// rejected so `--` cannot be turned into "somewhere else on disk".
import type { GitContext, GitRequest, GitSide } from "./types.ts";

const SHA_RE = /^[0-9a-f]{4,64}$/i;
/** A commit message longer than this is a paste accident, not a message. */
const MESSAGE_CAP = 100_000;
/** One request may touch at most this many paths (a whole-tree stage). */
const PATHS_CAP = 5_000;
const PATH_CAP = 4_096;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A repository-relative path git may be pointed at with `--`. */
export function isRepoPath(value: unknown): value is string {
  if (typeof value !== "string" || value === "" || value.length > PATH_CAP) return false;
  if (value.includes("\0") || value.startsWith("-")) return false;
  if (value.startsWith("/") || /^[a-zA-Z]:/.test(value)) return false;
  return !value.split(/[\\/]/).includes("..");
}

function asPaths(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > PATHS_CAP) return null;
  const paths: string[] = [];
  for (const item of value) {
    if (!isRepoPath(item)) return null;
    paths.push(item);
  }
  return paths;
}

function asSide(value: unknown): GitSide | null {
  return value === "worktree" || value === "index" ? value : null;
}

function asContext(value: unknown): GitContext | null {
  return value === "small" || value === "full" ? value : null;
}

/** A non-negative integer, used for hunk indices and pagination. */
function asCount(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

/**
 * A ref the history filter can start a walk at. The value becomes an argv word,
 * so option-looking or whitespace-carrying names are refused, as are the
 * revision syntax characters git would otherwise interpret.
 */
function asRev(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value === "" || value.length > 1_024) return undefined;
  if (/[\u0000-\u001f\u007f\s~^:?*\[\\]/.test(value)) return undefined;
  if (value.startsWith("-") || value.startsWith("/") || value.endsWith("/")) return undefined;
  if (value.endsWith(".") || value.endsWith(".lock") || value.includes("..") || value.includes("@{")) {
    return undefined;
  }
  return value;
}

/** Literal search text; empty means no search rather than a match-everything pattern. */
function asQuery(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value === "" || value.length > 200) return undefined;
  if (/[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return value;
}

/** Validate one request; null means malformed and nothing is run. */
export function parseRequest(body: unknown): GitRequest | null {
  if (!isRecord(body)) return null;
  switch (body.action) {
    case "status":
      return { action: "status" };
    case "fileDiff": {
      const side = asSide(body.side);
      const context = asContext(body.context);
      if (!isRepoPath(body.path) || side === null || context === null) return null;
      return { action: "fileDiff", path: body.path, side, context };
    }
    case "commitDiff": {
      if (typeof body.sha !== "string" || !SHA_RE.test(body.sha)) return null;
      return { action: "commitDiff", sha: body.sha };
    }
    case "commitFileDiff": {
      if (typeof body.sha !== "string" || !SHA_RE.test(body.sha) || !isRepoPath(body.path)) return null;
      return { action: "commitFileDiff", sha: body.sha, path: body.path };
    }
    case "commitDetail": {
      if (typeof body.sha !== "string" || !SHA_RE.test(body.sha)) return null;
      return { action: "commitDetail", sha: body.sha };
    }
    case "refs":
      return { action: "refs" };
    case "log": {
      const limit = asCount(body.limit, 1, 200);
      const skip = asCount(body.skip, 0, 1_000_000);
      const rev = asRev(body.rev);
      const query = asQuery(body.query);
      if (limit === null || skip === null || rev === undefined || query === undefined) return null;
      // A walk cannot both start at one ref and cover every ref.
      if (rev !== null && body.all === true) return null;
      return { action: "log", limit, skip, rev, all: body.all === true, query };
    }
    case "draftMessage":
      return { action: "draftMessage" };
    case "fetch":
      return { action: "fetch" };
    case "pull":
      return { action: "pull" };
    case "push":
      return { action: "push" };
    case "stage":
    case "unstage": {
      const paths = asPaths(body.paths);
      if (paths === null) return null;
      return { action: body.action, paths };
    }
    case "discard": {
      const paths = asPaths(body.paths);
      const scope = body.scope;
      if (paths === null) return null;
      if (scope !== "worktree" && scope !== "all" && scope !== "untracked") return null;
      return { action: "discard", paths, scope };
    }
    case "hunk": {
      const side = asSide(body.side);
      const context = asContext(body.context);
      const hunk = asCount(body.hunk, 0, 100_000);
      const op = body.op;
      if (!isRepoPath(body.path) || side === null || context === null || hunk === null) return null;
      if (op !== "stage" && op !== "unstage" && op !== "discard") return null;
      // Staging reads the worktree patch, unstaging the index patch. A request
      // that pairs the wrong side with an op would apply a patch backwards.
      if (op === "stage" && side !== "worktree") return null;
      if (op === "unstage" && side !== "index") return null;
      if (op === "discard" && side !== "worktree") return null;
      return { action: "hunk", path: body.path, side, hunk, op, context };
    }
    case "commit": {
      const message = body.message;
      if (typeof message !== "string" || message.length > MESSAGE_CAP || message.includes("\0")) return null;
      return { action: "commit", message, amend: body.amend === true };
    }
    default:
      return null;
  }
}