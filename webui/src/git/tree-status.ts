// Git tracking marks for the right panel's file tree: one status snapshot shared
// by every row, kept live by the repository change stream plus a slow poll (an
// edit in the worktree writes nothing under .git, so the stream cannot see it).
import type { GitFile, GitStatus } from "../../bridge/git/types";
import { callGit, watchGitChanges } from "./api";

/** The change a directory dot reports: the strongest one under that folder. */
export type DirChange = "conflict" | "worktree" | "staged" | "untracked";

/** Rank used to fold many paths into one directory dot; order is the display rule. */
const SEVERITY: Record<DirChange, number> = { untracked: 1, staged: 2, worktree: 3, conflict: 4 };

/** What one tree row shows: the index side first, then the worktree side. */
export type TrackMark = {
  /** Staged status letter, or null when the index holds no change for the path. */
  staged: string | null;
  /** Worktree status letter, or null when the worktree matches the index. */
  worktree: string | null;
  untracked: boolean;
  conflict: boolean;
};

const STATUS_POLL_MS = 4_000;

export class TreeStatusStore {
  /** Bumped on every snapshot; the tree subscribes to it for re-renders. */
  version = 0;
  /** Repository top level, or null until a status read has succeeded. */
  root: string | null = null;
  private marks = new Map<string, TrackMark>();
  /** Repo-relative directories, each with the strongest change under it. */
  private dirChanges = new Map<string, DirChange>();
  private subscribers = new Set<() => void>();
  private disposers: (() => void)[] = [];

  /** Subscribe the tree; the first subscriber starts reading, the last stops. */
  subscribe(listener: () => void): () => void {
    this.subscribers.add(listener);
    if (this.subscribers.size === 1) this.start();
    return () => {
      this.subscribers.delete(listener);
      if (this.subscribers.size === 0) this.stop();
    };
  }

  /** Read once, then follow the repository. */
  private start(): void {
    void this.refresh();
    this.disposers.push(
      watchGitChanges({
        onChange: () => void this.refresh(),
        onUnavailable: () => this.clear(),
      }),
    );
    const poll = window.setInterval(() => {
      // Without a repository there is nothing to poll for; the stream retries
      // on its own if the directory becomes one.
      if (document.visibilityState === "visible" && this.root !== null) void this.refresh();
    }, STATUS_POLL_MS);
    this.disposers.push(() => window.clearInterval(poll));
    const onFocus = (): void => void this.refresh();
    window.addEventListener("focus", onFocus);
    this.disposers.push(() => window.removeEventListener("focus", onFocus));
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") void this.refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    this.disposers.push(() => document.removeEventListener("visibilitychange", onVisibility));
  }

  private stop(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.clear();
  }

  /** Read the workspace's status; a failed read leaves the tree without marks. */
  async refresh(): Promise<void> {
    const res = await callGit({ action: "status" });
    if (!res.ok || res.action !== "status") {
      this.clear();
      return;
    }
    const marks = new Map<string, TrackMark>();
    const dirChanges = new Map<string, DirChange>();
    for (const file of res.status.files) {
      marks.set(file.path, markOf(file));
      const change = dirChange(file);
      if (change === null) continue;
      for (let dir = parentDir(file.path); dir !== ""; dir = parentDir(dir)) {
        const current = dirChanges.get(dir);
        if (current === undefined || SEVERITY[change] > SEVERITY[current]) dirChanges.set(dir, change);
      }
    }
    this.root = res.status.root;
    this.marks = marks;
    this.dirChanges = dirChanges;
    this.emit();
  }

  /** Marks of a repo-relative path, or null when it has no pending change. */
  mark(path: string): TrackMark | null {
    return this.marks.get(path) ?? null;
  }

  /** Strongest change under a repo-relative directory, or null when it is clean. */
  dirMark(path: string): DirChange | null {
    return this.dirChanges.get(path) ?? null;
  }

  private clear(): void {
    if (this.root === null && this.marks.size === 0) return;
    this.root = null;
    this.marks = new Map();
    this.dirChanges = new Map();
    this.emit();
  }

  private emit(): void {
    this.version += 1;
    for (const listener of this.subscribers) listener();
  }
}

export const treeStatus = new TreeStatusStore();

/**
 * The change a directory dot should carry for one status entry: a conflict
 * outranks a worktree edit, which outranks an index-only or untracked entry.
 */
export function dirChange(file: GitFile): DirChange | null {
  const mark = markOf(file);
  if (mark.conflict) return "conflict";
  if (mark.untracked) return "untracked";
  if (mark.worktree !== null) return "worktree";
  if (mark.staged !== null) return "staged";
  return null;
}

/** Staged and worktree letters of one status entry, with git's "." dropped. */
export function markOf(file: GitFile): TrackMark {
  return {
    // An untracked path reports "?" on both sides; the row shows a single U.
    staged: file.untracked || file.index === "." ? null : file.index,
    worktree: file.untracked || file.worktree === "." ? null : file.worktree,
    untracked: file.untracked,
    conflict: file.conflict !== null,
  };
}

/**
 * Repo-relative path of the working directory ("" at the top level), or null
 * when it sits outside the repository.
 */
export function repoPrefix(root: string, cwd: string): string | null {
  const trim = (path: string): string => path.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = trim(root);
  const here = trim(cwd);
  // Windows paths reach us from two sources, git and the shell, and differ in
  // case, so the prefix test folds case; the slice keeps the original spelling.
  const foldedBase = base.toLowerCase();
  const foldedHere = here.toLowerCase();
  if (foldedHere === foldedBase) return "";
  if (!foldedHere.startsWith(`${foldedBase}/`)) return null;
  return here.slice(base.length + 1);
}

/** Tree path (cwd-relative, "" for the root row) as a repo-relative path. */
export function repoPath(prefix: string, path: string): string {
  if (prefix === "") return path;
  return path === "" ? prefix : `${prefix}/${path}`;
}

/** Parent directory of a repo-relative path, "" at the top level. */
function parentDir(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}