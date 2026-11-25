// Page side of the Git view's API: every action is one POST /api/git, and the
// repository change stream is one EventSource. Replies are validated here (this
// is a wire boundary: the fields are unknown, not typed), so the store and the
// views only ever switch on checked shapes.
import type {
  GitCommit,
  GitConflictKind,
  GitErrorCode,
  GitFile,
  GitOperation,
  GitRef,
  GitRequest,
  GitResult,
  GitStatus,
} from "../../bridge/git/types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

const CONFLICTS: ReadonlySet<string> = new Set<GitConflictKind>([
  "bothModified",
  "bothAdded",
  "bothDeleted",
  "deletedByUs",
  "deletedByThem",
  "addedByUs",
  "addedByThem",
]);

function parseConflict(value: unknown): GitConflictKind | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && CONFLICTS.has(value) ? (value as GitConflictKind) : undefined;
}

function parseOperation(value: unknown): GitOperation | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const count = (raw: unknown): number | null | undefined =>
    raw === null ? null : typeof raw === "number" && Number.isInteger(raw) ? raw : undefined;
  switch (value.kind) {
    case "merge":
      return { kind: "merge" };
    case "bisect":
      return { kind: "bisect" };
    case "rebase": {
      const step = count(value.step);
      const total = count(value.total);
      const onto = value.onto;
      if (step === undefined || total === undefined) return undefined;
      if (onto !== null && typeof onto !== "string") return undefined;
      return { kind: "rebase", step, total, onto };
    }
    case "cherryPick":
    case "revert": {
      const remaining = count(value.remaining);
      if (remaining === undefined) return undefined;
      return { kind: value.kind, remaining };
    }
    default:
      return undefined;
  }
}

function parseFile(value: unknown): GitFile | null {
  if (!isRecord(value)) return null;
  const { path, origPath, index, worktree, untracked, add, del } = value;
  if (typeof path !== "string" || typeof index !== "string" || typeof worktree !== "string") return null;
  if (typeof untracked !== "boolean") return null;
  if (origPath !== null && typeof origPath !== "string") return null;
  if (add !== null && typeof add !== "number") return null;
  if (del !== null && typeof del !== "number") return null;
  const conflict = parseConflict(value.conflict);
  if (conflict === undefined) return null;
  return { path, origPath, index, worktree, untracked, conflict, add, del };
}

function parseStatus(value: unknown): GitStatus | null {
  if (!isRecord(value) || !Array.isArray(value.files)) return null;
  const { root, branch, upstream, detached, ahead, behind, unborn } = value;
  if (typeof root !== "string" || typeof detached !== "boolean" || typeof unborn !== "boolean") return null;
  if (typeof ahead !== "number" || typeof behind !== "number") return null;
  if (branch !== null && typeof branch !== "string") return null;
  if (upstream !== null && typeof upstream !== "string") return null;
  const operation = parseOperation(value.operation);
  if (operation === undefined) return null;
  const files: GitFile[] = [];
  for (const entry of value.files) {
    const file = parseFile(entry);
    if (file !== null) files.push(file);
  }
  return { root, branch, detached, upstream, ahead, behind, unborn, operation, files };
}

function parseCommits(value: unknown): GitCommit[] | null {
  if (!Array.isArray(value)) return null;
  const commits: GitCommit[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const { sha, short, author, date, subject, refs } = entry;
    if (typeof sha !== "string" || typeof short !== "string" || typeof author !== "string") continue;
    if (typeof date !== "string" || typeof subject !== "string") continue;
    commits.push({ sha, short, author, date, subject, refs: parseRefs(refs) });
  }
  return commits;
}

function parseRefs(value: unknown): GitRef[] {
  if (!Array.isArray(value)) return [];
  const refs: GitRef[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const { kind, name } = entry;
    if (typeof name !== "string" || name === "") continue;
    if (kind !== "branch" && kind !== "remote" && kind !== "tag") continue;
    refs.push({ kind, name });
  }
  return refs;
}

function parseErrorCode(value: unknown): GitErrorCode {
  switch (value) {
    case "invalid-request":
    case "not-a-repo":
    case "git-missing":
    case "index-locked":
    case "timeout":
      return value;
    default:
      return "failed";
  }
}

/** Validate the bridge's reply into a GitResult; never an unchecked cast. */
function parseResult(data: unknown): GitResult {
  if (!isRecord(data)) return { ok: false, error: "invalid reply from bridge", code: "failed" };
  if (data.ok === false) {
    const error = asString(data.error) ?? "git failed";
    return { ok: false, error, code: parseErrorCode(data.code) };
  }
  if (data.ok !== true) return { ok: false, error: "invalid reply from bridge", code: "failed" };
  switch (data.action) {
    case "status": {
      const status = parseStatus(data.status);
      return status !== null
        ? { ok: true, action: "status", status }
        : { ok: false, error: "invalid status reply", code: "failed" };
    }
    case "diff": {
      const diff = data.diff;
      if (!isRecord(diff) || typeof diff.text !== "string") {
        return { ok: false, error: "invalid diff reply", code: "failed" };
      }
      return {
        ok: true,
        action: "diff",
        diff: { text: diff.text, truncated: diff.truncated === true, binary: diff.binary === true },
      };
    }
    case "commits": {
      const commits = parseCommits(data.commits);
      if (commits === null) return { ok: false, error: "invalid log reply", code: "failed" };
      return { ok: true, action: "commits", commits, hasMore: data.hasMore === true };
    }
    case "message": {
      const message = asString(data.message);
      return message === null
        ? { ok: false, error: "invalid message reply", code: "failed" }
        : { ok: true, action: "message", message };
    }
    case "done":
      return { ok: true, action: "done", output: asString(data.output) ?? "" };
    default:
      return { ok: false, error: "unknown reply from bridge", code: "failed" };
  }
}

/** Run one validated git action against the attached session's workspace. */
export async function callGit(request: GitRequest): Promise<GitResult> {
  let res: Response;
  try {
    res = await fetch("/api/git", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), code: "failed" };
  }
  if (!res.ok) return { ok: false, error: `请求失败（${res.status}）`, code: "failed" };
  try {
    return parseResult(await res.json());
  } catch {
    return { ok: false, error: "invalid reply from bridge", code: "failed" };
  }
}

export type ChangeHandlers = {
  /** Something in the repository moved; refetch what is on screen. */
  onChange: () => void;
  /** The stream has no repository to watch (or none can be resolved). */
  onUnavailable: (error: string, code: GitErrorCode) => void;
};

/** Follow repository changes; returns a function that closes the stream. */
export function watchGitChanges(handlers: ChangeHandlers): () => void {
  const source = new EventSource("/api/git/events");
  source.addEventListener("change", () => handlers.onChange());
  source.addEventListener("unavailable", (event) => {
    // Bridge-controlled frame, but a truncated stream would throw here; treat
    // that as an unknown failure instead of breaking the listener.
    let data: unknown = null;
    try {
      data = JSON.parse((event as MessageEvent<string>).data);
    } catch {
      data = null;
    }
    const record = isRecord(data) ? data : {};
    handlers.onUnavailable(asString(record.error) ?? "not a git repository", parseErrorCode(record.code));
  });
  return () => source.close();
}