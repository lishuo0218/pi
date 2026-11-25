// Working-tree status for the Git view: one `status --porcelain=v2 -z` pass plus
// the two numstat passes that give each row its line counts. `-z` is used so
// paths arrive verbatim (spaces, non-ASCII, newlines) instead of quoted; every
// record is then NUL-separated and the fields within a record are space-separated.
import { errorCode, errorText, runGit, succeeded } from "./exec.ts";
import type { Repo } from "./repo.ts";
import { operationOf } from "./repo.ts";
import type { GitConflictKind, GitFile, GitResult, GitStatus } from "./types.ts";

type Stat = { add: number | null; del: number | null };

/** Porcelain v2 `u` codes: `DD`, `AU`, `UD`, `UA`, `DU`, `AA`, `UU`. */
function conflictOf(code: string): GitConflictKind | null {
  switch (code) {
    case "DD":
      return "bothDeleted";
    case "AU":
      return "addedByUs";
    case "UD":
      return "deletedByThem";
    case "UA":
      return "addedByThem";
    case "DU":
      return "deletedByUs";
    case "AA":
      return "bothAdded";
    case "UU":
      return "bothModified";
    default:
      return null;
  }
}

/** Parse `--numstat -z`: `add\tdel\tpath`, and for renames `add\tdel\t` then old, new. */
function parseNumstat(text: string): Map<string, Stat> {
  const stats = new Map<string, Stat>();
  const records = text.split("\0");
  for (let index = 0; index < records.length; index++) {
    const record = records[index] ?? "";
    if (record === "") continue;
    const first = record.indexOf("\t");
    const second = first < 0 ? -1 : record.indexOf("\t", first + 1);
    if (first < 0 || second < 0) continue;
    const add = record.slice(0, first);
    const del = record.slice(first + 1, second);
    const stat: Stat = {
      add: add === "-" ? null : Number(add),
      del: del === "-" ? null : Number(del),
    };
    const path = record.slice(second + 1);
    if (path !== "") {
      stats.set(path, stat);
      continue;
    }
    // Rename: the record's path field is empty and the two paths follow as
    // their own NUL-separated fields. The row shows the new path.
    const newPath = records[index + 2];
    index += 2;
    if (newPath !== undefined && newPath !== "") stats.set(newPath, stat);
  }
  return stats;
}

function statFor(stats: Map<string, Stat>, path: string): Stat {
  return stats.get(path) ?? { add: null, del: null };
}

/** Parse `status --porcelain=v2 --branch -z`. */
export function parseStatus(
  text: string,
  stagedStats: Map<string, Stat>,
  unstagedStats: Map<string, Stat>,
  root: string,
): Omit<GitStatus, "operation"> {
  let branch: string | null = null;
  let detached = false;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  let unborn = false;
  const files: GitFile[] = [];
  const records = text.split("\0");
  for (let index = 0; index < records.length; index++) {
    const record = records[index] ?? "";
    if (record === "") continue;
    if (record.startsWith("# branch.oid ")) {
      unborn = record.slice("# branch.oid ".length) === "(initial)";
      continue;
    }
    if (record.startsWith("# branch.head ")) {
      const head = record.slice("# branch.head ".length);
      if (head === "(detached)") detached = true;
      else branch = head;
      continue;
    }
    if (record.startsWith("# branch.upstream ")) {
      upstream = record.slice("# branch.upstream ".length);
      continue;
    }
    if (record.startsWith("# branch.ab ")) {
      const match = /^\+(\d+) -(\d+)$/.exec(record.slice("# branch.ab ".length));
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
      continue;
    }
    if (record.startsWith("#")) continue;
    const kind = record[0];
    if (kind === "1" || kind === "u") {
      // "1" has 8 fields before the path, "u" (unmerged) has 10.
      const parts = record.split(" ");
      const xy = parts[1] ?? "..";
      const indexStatus = xy[0] ?? ".";
      const worktreeStatus = xy[1] ?? ".";
      const path = parts.slice(kind === "1" ? 8 : 10).join(" ");
      if (path === "") continue;
      const stat =
        worktreeStatus !== "." ? statFor(unstagedStats, path) : statFor(stagedStats, path);
      files.push({
        path,
        origPath: null,
        index: indexStatus,
        worktree: worktreeStatus,
        untracked: false,
        conflict: kind === "u" ? conflictOf(xy) : null,
        add: stat.add,
        del: stat.del,
      });
      continue;
    }
    if (kind === "2") {
      // Rename/copy: 9 fields, then the path; the original path is its own
      // NUL-separated record.
      const parts = record.split(" ");
      const xy = parts[1] ?? "..";
      const indexStatus = xy[0] ?? ".";
      const worktreeStatus = xy[1] ?? ".";
      const path = parts.slice(9).join(" ");
      const origPath = records[index + 1] ?? null;
      index += 1;
      if (path === "") continue;
      const stat =
        worktreeStatus !== "." ? statFor(unstagedStats, path) : statFor(stagedStats, path);
      files.push({
        path,
        origPath: origPath === "" ? null : origPath,
        index: indexStatus,
        worktree: worktreeStatus,
        untracked: false,
        conflict: null,
        add: stat.add,
        del: stat.del,
      });
      continue;
    }
    if (kind === "?") {
      const path = record.slice(2);
      if (path === "") continue;
      files.push({
        path,
        origPath: null,
        index: "?",
        worktree: "?",
        untracked: true,
        conflict: null,
        add: null,
        del: null,
      });
    }
  }
  return { root, branch, detached, upstream, ahead, behind, unborn, files };
}

/** Read the repository's status. */
export async function readStatus(repo: Repo): Promise<GitResult> {
  const [statusRun, unstagedRun, stagedRun, operation] = await Promise.all([
    runGit(repo.root, ["status", "--porcelain=v2", "--branch", "--untracked-files=all", "-z"]),
    runGit(repo.root, ["diff", "--numstat", "-z"]),
    runGit(repo.root, ["diff", "--cached", "--numstat", "-z"]),
    operationOf(repo),
  ]);
  if (!succeeded(statusRun)) {
    return { ok: false, error: errorText(statusRun, "git status"), code: errorCode(statusRun) };
  }
  const parsed = parseStatus(
    statusRun.stdout,
    parseNumstat(stagedRun.stdout),
    parseNumstat(unstagedRun.stdout),
    repo.root,
  );
  return { ok: true, action: "status", status: { ...parsed, operation } };
}