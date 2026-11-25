// State of the Git view: repository status, the current selection (one side of
// one file, one commit, or one file inside a commit), its patch, the commit's
// detail, history scope/search/paging, and one serialized write path so two
// clicks cannot race on the index. The view subscribes to `version`; nothing
// here touches the DOM.
import type {
  GitCommit,
  GitCommitDetail,
  GitContext,
  GitDiff,
  GitErrorCode,
  GitFile,
  GitRefNames,
  GitRequest,
  GitSide,
  GitStatus,
} from "../../bridge/git/types";
import { callGit, watchGitChanges } from "./api";

export type GitStatusState =
  | { kind: "loading" }
  | { kind: "ready"; status: GitStatus }
  | { kind: "error"; error: string; code: GitErrorCode };

/** Which commits the history column walks. */
export type GitScope = { kind: "head" } | { kind: "all" } | { kind: "ref"; name: string };

/** What the right pane shows: one file side, or one commit (all of it or one file). */
export type GitSelection =
  | { kind: "file"; path: string; side: GitSide; untracked: boolean }
  | { kind: "commit"; commit: GitCommit; file: string | null };

export type GitDiffState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; diff: GitDiff }
  | { kind: "error"; error: string; code: GitErrorCode };

export type GitDetailState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; detail: GitCommitDetail }
  | { kind: "error"; error: string };

export type GitHistoryState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; error: string }
  | { kind: "ready" };

export type GitNotice = { text: string; level: "ok" | "error" };

/** A destructive write waiting for the view's confirmation dialog. */
export type GitConfirm = { message: string; label: string; run: () => void };

const HISTORY_PAGE = 50;
/**
 * Worktree edits do not touch `.git`, so the change stream cannot see them. A
 * slow status poll covers exactly that case while the view is open; .git
 * changes still arrive through the stream and refresh immediately.
 */
const STATUS_POLL_MS = 4_000;
const NOTICE_MS = 4_000;

function sameScope(left: GitScope, right: GitScope): boolean {
  if (left.kind === "ref" && right.kind === "ref") return left.name === right.name;
  return left.kind === right.kind;
}

export class GitStore {
  status: GitStatusState = { kind: "loading" };
  selection: GitSelection | null = null;
  diff: GitDiffState = { kind: "idle" };
  /** Context of the open file patch; `full` folds the gaps instead of hiding them. */
  context: GitContext = "small";
  detail: GitDetailState = { kind: "idle" };
  /** Branches, remotes and tags the history filter lists. */
  refs: GitRefNames | null = null;
  scope: GitScope = { kind: "head" };
  /** Literal text the history walk matches against message and author. */
  historyQuery = "";
  history: GitHistoryState = { kind: "idle" };
  commits: GitCommit[] = [];
  hasMore = false;
  /** True while a follow-up history page is in flight; the list tail shows it. */
  loadingMore = false;
  /** A write is in flight: every write control is disabled meanwhile. */
  busy = false;
  /** A commit-message draft is in flight; the draft button shows it. */
  drafting = false;
  notice: GitNotice | null = null;
  /** Set by a destructive action; the view renders it and calls back. */
  confirm: GitConfirm | null = null;
  version = 0;
  private subscribers = new Set<() => void>();
  private writing = false;
  private diffSeq = 0;
  private detailSeq = 0;
  private historySeq = 0;
  private closeStream: (() => void) | null = null;
  private disposers: (() => void)[] = [];
  private noticeTimer: number | null = null;

  subscribe(listener: () => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  private emit(): void {
    this.version += 1;
    for (const listener of this.subscribers) listener();
  }

  /** Load once, then follow the repository and the window's focus. */
  start(): void {
    void this.refreshStatus();
    void this.loadRefs();
    this.closeStream = watchGitChanges({
      onChange: () => void this.onRepositoryChange(),
      onUnavailable: (error, code) => {
        this.status = { kind: "error", error, code };
        this.emit();
      },
    });
    const onFocus = (): void => void this.refreshStatus();
    window.addEventListener("focus", onFocus);
    this.disposers.push(() => window.removeEventListener("focus", onFocus));
    const poll = window.setInterval(() => {
      if (document.visibilityState === "visible" && !this.writing) void this.refreshStatus();
    }, STATUS_POLL_MS);
    this.disposers.push(() => window.clearInterval(poll));
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") void this.refreshStatus();
    };
    document.addEventListener("visibilitychange", onVisibility);
    this.disposers.push(() => document.removeEventListener("visibilitychange", onVisibility));
  }

  dispose(): void {
    this.closeStream?.();
    this.closeStream = null;
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    if (this.noticeTimer !== null) window.clearTimeout(this.noticeTimer);
    this.subscribers.clear();
  }

  /** The ready status, or null while loading / failed. */
  get readyStatus(): GitStatus | null {
    return this.status.kind === "ready" ? this.status.status : null;
  }

  async refreshStatus(): Promise<void> {
    const res = await callGit({ action: "status" });
    if (!res.ok) {
      this.status = { kind: "error", error: res.error, code: res.code };
      this.emit();
      return;
    }
    if (res.action !== "status") return;
    this.status = { kind: "ready", status: res.status };
    this.reconcileSelection(res.status);
    this.emit();
  }

  /**
   * Keep the selection valid across refreshes: a file that moved from the
   * worktree side to the index follows it (staging leaves the user looking at
   * the side they just changed), and a file that became clean is dropped.
   */
  private reconcileSelection(status: GitStatus): void {
    const selection = this.selection;
    if (selection === null || selection.kind !== "file") return;
    const file = status.files.find((entry) => entry.path === selection.path);
    if (file === undefined) {
      this.selection = null;
      this.diff = { kind: "idle" };
      return;
    }
    const hasWorktree = file.worktree !== ".";
    const hasIndex = file.index !== ".";
    if (selection.side === "worktree" && !hasWorktree && hasIndex) {
      this.selection = { ...selection, side: "index", untracked: file.untracked };
      return;
    }
    if (selection.side === "index" && !hasIndex && hasWorktree) {
      this.selection = { ...selection, side: "worktree", untracked: file.untracked };
      return;
    }
    if (!hasWorktree && !hasIndex) {
      this.selection = null;
      this.diff = { kind: "idle" };
    }
  }

  private async onRepositoryChange(): Promise<void> {
    await this.refreshStatus();
    if (!this.writing) await this.fetchDiff(false);
  }

  selectFile(file: GitFile, side: GitSide): void {
    this.selection = { kind: "file", path: file.path, side, untracked: file.untracked };
    this.detail = { kind: "idle" };
    void this.fetchDiff(true);
  }

  selectCommit(commit: GitCommit): void {
    const current = this.selection;
    if (
      current !== null &&
      current.kind === "commit" &&
      current.commit.sha === commit.sha &&
      this.detail.kind !== "error"
    ) {
      return;
    }
    this.selection = { kind: "commit", commit, file: null };
    this.detail = { kind: "loading" };
    this.emit();
    void this.loadDetail(commit.sha);
    void this.fetchDiff(true);
  }

  /** Open one file of the selected commit, or the whole commit for null. */
  selectCommitFile(path: string | null): void {
    const selection = this.selection;
    if (selection === null || selection.kind !== "commit") return;
    if (selection.file === path && this.diff.kind !== "error") return;
    this.selection = { ...selection, file: path };
    void this.fetchDiff(true);
  }

  /**
   * Open another commit by sha (a parent link): its detail supplies the commit
   * fields the history row would have, so the pane waits for that one read.
   */
  async openCommit(sha: string): Promise<void> {
    const seq = ++this.detailSeq;
    this.detail = { kind: "loading" };
    this.emit();
    const res = await callGit({ action: "commitDetail", sha });
    if (seq !== this.detailSeq) return;
    if (!res.ok) {
      this.detail = { kind: "error", error: res.error };
      this.emit();
      return;
    }
    if (res.action !== "detail") return;
    this.selection = { kind: "commit", commit: res.detail.commit, file: null };
    this.detail = { kind: "ready", detail: res.detail };
    this.emit();
    await this.fetchDiff(true);
  }

  private async loadDetail(sha: string): Promise<void> {
    const seq = ++this.detailSeq;
    const res = await callGit({ action: "commitDetail", sha });
    if (seq !== this.detailSeq) return;
    const selection = this.selection;
    if (selection === null || selection.kind !== "commit" || selection.commit.sha !== sha) return;
    if (!res.ok) {
      this.detail = { kind: "error", error: res.error };
      this.emit();
      return;
    }
    if (res.action !== "detail") return;
    this.detail = { kind: "ready", detail: res.detail };
    // The detail read also refreshes the row's refs and parents.
    if (this.selection === selection) this.selection = { ...selection, commit: res.detail.commit };
    this.emit();
  }

  clearSelection(): void {
    if (this.selection === null) return;
    this.selection = null;
    this.diff = { kind: "idle" };
    this.detail = { kind: "idle" };
    this.emit();
  }

  /** Switch the open file patch between 3 lines and all of its context. */
  setContext(context: GitContext): void {
    if (this.context === context) return;
    this.context = context;
    void this.fetchDiff(true);
  }

  private requestFor(selection: GitSelection): GitRequest {
    if (selection.kind === "commit") {
      return selection.file === null
        ? { action: "commitDiff", sha: selection.commit.sha }
        : { action: "commitFileDiff", sha: selection.commit.sha, path: selection.file };
    }
    return { action: "fileDiff", path: selection.path, side: selection.side, context: this.context };
  }

  /** Read the selected patch; `showLoading` is false for silent refreshes. */
  private async fetchDiff(showLoading: boolean): Promise<void> {
    const selection = this.selection;
    if (selection === null) {
      this.diff = { kind: "idle" };
      this.emit();
      return;
    }
    const seq = ++this.diffSeq;
    if (showLoading) {
      this.diff = { kind: "loading" };
      this.emit();
    }
    const res = await callGit(this.requestFor(selection));
    // A newer selection or refresh owns the pane now.
    if (seq !== this.diffSeq || this.selection !== selection) return;
    if (!res.ok) {
      this.diff = { kind: "error", error: res.error, code: res.code };
      this.emit();
      return;
    }
    if (res.action !== "diff") return;
    this.diff = { kind: "ready", diff: res.diff };
    this.emit();
  }

  private notify(text: string, level: "ok" | "error"): void {
    this.notice = { text, level };
    if (this.noticeTimer !== null) window.clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => {
      this.noticeTimer = null;
      this.notice = null;
      this.emit();
    }, NOTICE_MS);
  }

  /** git's own first useful output line, e.g. `[main 1a2b3c] subject`. */
  private static doneText(res: { action: "done"; output: string }, fallback: string): string {
    const line = res.output
      .split("\n")
      .map((part) => part.trim())
      .find((part) => part !== "" && !part.startsWith("warning:") && !part.startsWith("提示："));
    return line ?? fallback;
  }

  /** Run one write, report it, then refresh everything it could have changed. */
  private async runWrite(label: string, request: GitRequest): Promise<boolean> {
    if (this.writing) return false;
    this.writing = true;
    this.busy = true;
    this.emit();
    const res = await callGit(request);
    this.writing = false;
    this.busy = false;
    if (!res.ok) {
      this.notify(`${label}失败：${res.error}`, "error");
      this.emit();
      return false;
    }
    this.notify(res.action === "done" ? GitStore.doneText(res, `${label}完成`) : `${label}完成`, "ok");
    this.followWrittenSide(request);
    await this.refreshStatus();
    await this.fetchDiff(false);
    return true;
  }

  /**
   * After staging (or unstaging) the open file, keep looking at the side that
   * now holds the change instead of leaving the pane on the emptied side.
   */
  private followWrittenSide(request: GitRequest): void {
    const selection = this.selection;
    if (selection === null || selection.kind !== "file") return;
    let paths: string[] = [];
    let target: GitSide | null = null;
    if (request.action === "stage") {
      paths = request.paths;
      target = "index";
    } else if (request.action === "unstage") {
      paths = request.paths;
      target = "worktree";
    } else if (request.action === "hunk") {
      paths = [request.path];
      target = request.op === "stage" ? "index" : request.op === "unstage" ? "worktree" : null;
    }
    if (target === null || !paths.includes(selection.path)) return;
    this.selection = { ...selection, side: target };
  }

  stage(paths: string[]): Promise<boolean> {
    return this.runWrite("暂存", { action: "stage", paths });
  }

  /** Refresh remote-tracking refs; ahead/behind comes back with the status. */
  async fetchRemote(): Promise<boolean> {
    const ok = await this.runWrite("获取", { action: "fetch" });
    if (ok) this.refreshHistory();
    return ok;
  }

  /** Fast-forward only: a diverged branch is refused instead of merged. */
  async pull(): Promise<boolean> {
    const ok = await this.runWrite("拉取", { action: "pull" });
    if (ok) await this.refreshHistory();
    return ok;
  }

  async push(): Promise<boolean> {
    const ok = await this.runWrite("推送", { action: "push" });
    if (ok) this.refreshHistory();
    return ok;
  }

  /**
   * Every network action moves remote-tracking refs, so both the filter list and
   * the badges of the loaded commits are stale afterwards. Reloading page one is
   * the only way to re-read them; a deep scroll position resets to the top.
   */
  private async refreshHistory(): Promise<void> {
    void this.loadRefs();
    if (this.history.kind === "ready") await this.loadHistory(false);
  }

  /** Pushing publishes commits to a remote, so it asks first. */
  requestPush(branch: string, upstream: string): void {
    this.requestConfirm(`推送 ${branch} 到 ${upstream}？`, "推送", () => void this.push());
  }

  unstage(paths: string[]): Promise<boolean> {
    return this.runWrite("取消暂存", { action: "unstage", paths });
  }

  discard(paths: string[], scope: "worktree" | "all" | "untracked"): Promise<boolean> {
    const label = scope === "untracked" ? "删除" : "丢弃";
    return this.runWrite(label, { action: "discard", paths, scope });
  }

  /**
   * Destructive writes ask first: discard and delete lose work that git cannot
   * recover (untracked files are not in any object store at all).
   */
  requestDiscard(paths: string[], scope: "worktree" | "all" | "untracked", message: string): void {
    this.requestConfirm(message, scope === "untracked" ? "删除" : "丢弃", () => void this.discard(paths, scope));
  }

  /** Same confirmation path for one hunk of the open file. */
  requestDiscardFile(path: string, side: GitSide, hunk: number, message: string): void {
    this.requestConfirm(message, "丢弃", () => void this.hunk(path, side, hunk, "discard"));
  }

  /** Ask the view for a yes/no before running something that loses work. */
  requestConfirm(message: string, label: string, run: () => void): void {
    if (this.busy) return;
    this.confirm = { message, label, run };
    this.emit();
  }

  confirmPending(): void {
    const pending = this.confirm;
    this.confirm = null;
    this.emit();
    pending?.run();
  }

  cancelConfirm(): void {
    if (this.confirm === null) return;
    this.confirm = null;
    this.emit();
  }

  hunk(path: string, side: GitSide, hunk: number, op: "stage" | "unstage" | "discard"): Promise<boolean> {
    const label = op === "stage" ? "暂存改动块" : op === "unstage" ? "取消暂存改动块" : "丢弃改动块";
    return this.runWrite(label, { action: "hunk", path, side, hunk, op, context: this.context });
  }

  async commit(message: string, amend: boolean): Promise<boolean> {
    const ok = await this.runWrite(amend ? "修补提交" : "提交", { action: "commit", message, amend });
    if (ok && this.history.kind === "ready") await this.loadHistory(false);
    return ok;
  }

  /**
   * Ask the bridge for an AI-written message; the view owns the text box, so
   * the draft comes back as a value (null means the notice already says why).
   */
  async draftMessage(): Promise<string | null> {
    if (this.drafting) return null;
    this.drafting = true;
    this.emit();
    const res = await callGit({ action: "draftMessage" });
    this.drafting = false;
    this.emit();
    if (!res.ok) {
      this.notify(`生成提交说明失败：${res.error}`, "error");
      return null;
    }
    if (res.action !== "message") return null;
    return res.message;
  }

  /** Read the branch/remote/tag names the history filter lists. */
  async loadRefs(): Promise<void> {
    const res = await callGit({ action: "refs" });
    if (!res.ok || res.action !== "refs") return;
    this.refs = res.refs;
    this.emit();
  }

  /** Walk another starting point; the list starts over from its newest commit. */
  setScope(scope: GitScope): void {
    if (sameScope(this.scope, scope)) return;
    this.scope = scope;
    void this.loadHistory(false);
  }

  /** Search message and author literally; the walk restarts from the first match. */
  setHistoryQuery(query: string): void {
    if (this.historyQuery === query) return;
    this.historyQuery = query;
    void this.loadHistory(false);
  }

  /** Load the first page of history, or one more page after it. */
  async loadHistory(more: boolean): Promise<void> {
    // The list tail asks for the next page whenever it becomes visible, which
    // would otherwise stack identical requests.
    if (more && this.loadingMore) return;
    const seq = ++this.historySeq;
    if (more) {
      this.loadingMore = true;
    } else {
      this.history = { kind: "loading" };
    }
    this.emit();
    const scope = this.scope;
    const res = await callGit({
      action: "log",
      limit: HISTORY_PAGE,
      skip: more ? this.commits.length : 0,
      rev: scope.kind === "ref" ? scope.name : null,
      all: scope.kind === "all",
      query: this.historyQuery === "" ? null : this.historyQuery,
    });
    this.loadingMore = false;
    if (seq !== this.historySeq) return;
    if (!res.ok) {
      this.history = { kind: "error", error: res.error };
      this.emit();
      return;
    }
    if (res.action !== "commits") return;
    this.commits = more ? [...this.commits, ...res.commits] : res.commits;
    this.hasMore = res.hasMore;
    this.history = { kind: "ready" };
    this.emit();
  }
}