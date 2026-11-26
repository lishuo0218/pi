// Page side of the Git view's API: every action is one POST /api/git, and the
// repository change stream is one EventSource. Replies are validated here (this
// is a wire boundary: the fields are unknown, not typed), so the store and the
// views only ever switch on checked shapes.
import type {
  GitCommit,
  GitCommitDetail,
  GitCommitFile,
  GitConflictKind,
  GitErrorCode,
  GitFile,
  GitLineStats,
  GitOperation,
  GitRef,
  GitRefNames,
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

function parseLineStats(value: unknown): GitLineStats | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const { add, del } = value;
  if (add !== null && typeof add !== "number") return undefined;
  if (del !== null && typeof del !== "number") return undefined;
  return { add, del };
}

function parseFile(value: unknown): GitFile | null {
  if (!isRecord(value)) return null;
  const { path, origPath, index, worktree, untracked } = value;
  if (typeof path !== "string" || typeof index !== "string" || typeof worktree !== "string") return null;
  if (typeof untracked !== "boolean") return null;
  if (origPath !== null && typeof origPath !== "string") return null;
  const indexStats = parseLineStats(value.indexStats);
  const worktreeStats = parseLineStats(value.worktreeStats);
  if (indexStats === undefined || worktreeStats === undefined) return null;
  const conflict = parseConflict(value.conflict);
  if (conflict === undefined) return null;
  return { path, origPath, index, worktree, untracked, conflict, indexStats, worktreeStats };
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
    const parents = parseStrings(entry.parents);
    commits.push({ sha, short, author, date, subject, parents, refs: parseRefs(refs) });
  }
  return commits;
}

function parseStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item !== "");
}

function parseRefNames(value: unknown): GitRefNames | null {
  if (!isRecord(value)) return null;
  return { local: parseStrings(value.local), remote: parseStrings(value.remote), tag: parseStrings(value.tag) };
}

function parseCommitFiles(value: unknown): GitCommitFile[] {
  if (!Array.isArray(value)) return [];
  const files: GitCommitFile[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.path !== "string") continue;
    const add = entry.add;
    const del = entry.del;
    files.push({
      path: entry.path,
      add: typeof add === "number" ? add : null,
      del: typeof del === "number" ? del : null,
    });
  }
  return files;
}

function parseCommitDetail(value: unknown): GitCommitDetail | null {
  if (!isRecord(value)) return null;
  const commit = parseCommits([value.commit]);
  const stats = value.stats;
  if (commit === null || commit[0] === undefined || !isRecord(stats)) return null;
  const { files, add, del } = stats;
  if (typeof files !== "number" || typeof add !== "number" || typeof del !== "number") return null;
  return { commit: commit[0], stats: { files, add, del }, files: parseCommitFiles(value.files) };
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
    case "refs": {
      const refs = parseRefNames(data.refs);
      return refs === null
        ? { ok: false, error: "invalid refs reply", code: "failed" }
        : { ok: true, action: "refs", refs };
    }
    case "detail": {
      const detail = parseCommitDetail(data.detail);
      return detail === null
        ? { ok: false, error: "invalid commit detail reply", code: "failed" }
        : { ok: true, action: "detail", detail };
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

/** One frame of the draft stream; the bridge owns the shape. */
type DraftFrame =
  | { type: "snapshot"; text: string }
  | { type: "done"; message: string }
  | { type: "error"; error: string; code: GitErrorCode };

/** Parse one SSE frame; null for comments, keep-alives and unknown shapes. */
function parseDraftFrame(raw: string): DraftFrame | null {
  const data = raw
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");
  if (data === "") return null;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (value.type === "snapshot" && typeof value.text === "string") return { type: "snapshot", text: value.text };
  if (value.type === "done" && typeof value.message === "string") return { type: "done", message: value.message };
  if (value.type === "error" && typeof value.error === "string") {
    return { type: "error", error: value.error, code: parseErrorCode(value.code) };
  }
  return null;
}

/**
 * The page's copy is Simplified Chinese; the drafted message follows it, so a
 * translated UI changes this line and the matching rules in the bridge.
 */
const UI_LANGUAGE = "zh";

/**
 * Ask for an AI commit message, delivering the text as it arrives: the reply is
 * a stream of snapshots, so the box fills while the model writes. Aborting
 * `signal` stops the model run and leaves the text received so far in place.
 */
export async function streamGitDraft(handlers: {
  onSnapshot: (text: string) => void;
  signal: AbortSignal;
}): Promise<GitResult> {
  let res: Response;
  try {
    res = await fetch(`/api/git/draft?lang=${UI_LANGUAGE}`, { method: "POST", signal: handlers.signal });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), code: "failed" };
  }
  if (!res.ok || res.body === null) return { ok: false, error: `请求失败（${res.status}）`, code: "failed" };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end = buffer.indexOf("\n\n");
      while (end >= 0) {
        const frame = parseDraftFrame(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        if (frame !== null) {
          if (frame.type === "snapshot") handlers.onSnapshot(frame.text);
          else if (frame.type === "done") return { ok: true, action: "message", message: frame.message };
          else return { ok: false, error: frame.error, code: frame.code };
        }
        end = buffer.indexOf("\n\n");
      }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), code: "failed" };
  }
  return { ok: false, error: "生成中断", code: "failed" };
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