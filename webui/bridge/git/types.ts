// Wire types of the Git view: what POST /api/git accepts and returns, plus the
// shapes the page renders. The page imports these as types only, so this file
// must stay free of runtime imports.

/** Which diff of a changed file a request is about. */
export type GitSide = "worktree" | "index";

/**
 * How much unchanged context a file patch carries. `full` lets the page fold
 * the gaps between changes instead of showing three lines; a hunk request must
 * use the same value, because hunk indices number the hunks of that patch.
 */
export type GitContext = "small" | "full";

/** Unmerged code (porcelain v2 `u` line) in the words git uses. */
export type GitConflictKind =
  | "bothModified"
  | "bothAdded"
  | "bothDeleted"
  | "deletedByUs"
  | "deletedByThem"
  | "addedByUs"
  | "addedByThem";

/** A merge, rebase, cherry-pick, revert or bisect the repository is paused in. */
export type GitOperation =
  | { kind: "merge" }
  | { kind: "rebase"; step: number | null; total: number | null; onto: string | null }
  | { kind: "cherryPick"; remaining: number | null }
  | { kind: "revert"; remaining: number | null }
  | { kind: "bisect" };

export type GitFile = {
  path: string;
  /** Source path of a rename/copy, else null. */
  origPath: string | null;
  /** Staged status letter; "." when unchanged. */
  index: string;
  /** Worktree status letter; "." when unchanged. */
  worktree: string;
  untracked: boolean;
  /** Unmerged code, or null when the path merged cleanly. */
  conflict: GitConflictKind | null;
  /**
   * numstat line counts for the side the row shows: the worktree diff when the
   * worktree changed, else the staged diff. null for binary and untracked
   * paths, and ambiguous (worktree numbers) when both sides changed.
   */
  add: number | null;
  del: number | null;
};

export type GitStatus = {
  /** Absolute path of the repository top level; every `path` is relative to it. */
  root: string;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** True on a branch with no commits yet. */
  unborn: boolean;
  operation: GitOperation | null;
  files: GitFile[];
};

export type GitCommit = {
  sha: string;
  short: string;
  author: string;
  date: string;
  subject: string;
  /** Full shas of the parent commits; the history graph draws a lane per parent. */
  parents: string[];
  /** Branches, remote-tracking refs and tags that point at this commit. */
  refs: GitRef[];
};

/** A ref decoration: what kind it is decides its badge in the history column. */
export type GitRef = { kind: "branch" | "remote" | "tag"; name: string };

/** Names the history filter lists, grouped by the kind the select renders. */
export type GitRefNames = { local: string[]; remote: string[]; tag: string[] };

export type GitStats = { files: number; add: number; del: number };

/** One file of a commit: its numstat counts; null counts mean binary. */
export type GitCommitFile = { path: string; add: number | null; del: number | null };

/** What the right pane needs for a selected commit besides its patch. */
export type GitCommitDetail = {
  commit: GitCommit;
  stats: GitStats;
  files: GitCommitFile[];
};

/** A patch as git printed it, plus the flags the page needs to render it. */
export type GitDiff = {
  text: string;
  truncated: boolean;
  binary: boolean;
};

/**
 * Why a request failed, as far as the page can act on it: `not-a-repo` and
 * `git-missing` are setup states, `index-locked` means another git process is
 * writing, `timeout` means the command outlived its budget.
 */
export type GitErrorCode =
  | "invalid-request"
  | "not-a-repo"
  | "git-missing"
  | "index-locked"
  | "timeout"
  | "failed";

export type GitRequest =
  | { action: "status" }
  | { action: "fileDiff"; path: string; side: GitSide; context: GitContext }
  | { action: "commitDiff"; sha: string }
  | { action: "commitFileDiff"; sha: string; path: string }
  | { action: "commitDetail"; sha: string }
  | { action: "refs" }
  | {
      action: "log";
      limit: number;
      skip: number;
      /** Ref to walk, or null for HEAD. */
      rev: string | null;
      /** Walk every ref (`--all`) instead of a single starting point. */
      all: boolean;
      /** Literal text matched against the message or the author name. */
      query: string | null;
    }
  | { action: "draftMessage" }
  | { action: "fetch" }
  | { action: "pull" }
  | { action: "push" }
  | { action: "stage"; paths: string[] }
  | { action: "unstage"; paths: string[] }
  | {
      action: "discard";
      paths: string[];
      /** Worktree only keeps the index; all also drops staged changes. */
      scope: "worktree" | "all" | "untracked";
    }
  | {
      action: "hunk";
      path: string;
      side: GitSide;
      context: GitContext;
      /** Index of the hunk inside that side's patch, as the page rendered it. */
      hunk: number;
      op: "stage" | "unstage" | "discard";
    }
  | { action: "commit"; message: string; amend: boolean };

/** Reply to POST /api/git. The action tag lets the page switch, not guess. */
export type GitResult =
  | { ok: true; action: "status"; status: GitStatus }
  | { ok: true; action: "diff"; diff: GitDiff }
  | { ok: true; action: "commits"; commits: GitCommit[]; hasMore: boolean }
  | { ok: true; action: "refs"; refs: GitRefNames }
  | { ok: true; action: "detail"; detail: GitCommitDetail }
  | { ok: true; action: "message"; message: string }
  | { ok: true; action: "done"; output: string }
  | { ok: false; error: string; code: GitErrorCode };

/** Reply to POST /api/git: the page switches on `ok`, then on `action`. */
export function gitError(error: string, code: GitErrorCode): GitResult {
  return { ok: false, error, code };
}