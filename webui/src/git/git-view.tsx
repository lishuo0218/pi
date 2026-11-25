// Full-screen Git view (F-29): branch header, a changed-file column, a history
// column and a right pane that shows the selected patch or commit. Esc leaves
// the view; destructive writes stop here for confirmation.
import { useEffect, useMemo, useRef } from "preact/hooks";
import { useSyncExternalStore } from "preact/compat";
import type { JSX } from "preact";
import type { GitFile, GitSide } from "../../bridge/git/types";
import { GitChanges } from "./changes";
import { GitCommitBox } from "./commit";
import { GitDiffView, type HunkActions } from "./diff-view";
import { parsePatch } from "./diff-parse";
import { GitHistory } from "./history";
import { GitStore } from "./store";

/** Why the repository could not be read, in the words that help the user act. */
function setupMessage(error: string, code: string): string {
  switch (code) {
    case "not-a-repo":
      return "当前目录不是 git 仓库（或还没有 git 仓库）。在这里执行 git init 后再打开。";
    case "git-missing":
      return "找不到 git 可执行文件，请先安装 git。";
    case "index-locked":
      return "另一个 git 进程正在写入索引，稍后重试。";
    case "timeout":
      return "git 命令超时，仓库可能过大或磁盘很慢。";
    default:
      return error;
  }
}

export function GitView({ onClose }: { onClose: () => void }): JSX.Element {
  const storeRef = useRef<GitStore | null>(null);
  if (storeRef.current === null) storeRef.current = new GitStore();
  const store = storeRef.current;
  useSyncExternalStore(
    (callback) => store.subscribe(callback),
    () => store.version,
  );

  useEffect(() => {
    store.start();
    return () => store.dispose();
  }, [store]);

  // Capture phase so the view's Esc wins over the app's own handlers; the
  // diff pane's find bar registers earlier and stops its own Escape.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      if (store.confirm !== null) {
        store.cancelConfirm();
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [store, onClose]);

  const status = store.readyStatus;
  const selection = store.selection;
  const diffState = store.diff;

  const rows = useMemo(
    () => (diffState.kind === "ready" ? parsePatch(diffState.diff.text) : []),
    [diffState],
  );

  /** The file the open patch belongs to, for its header and its actions. */
  const openFile: GitFile | null =
    selection !== null && selection.kind === "file" && status !== null
      ? (status.files.find((file) => file.path === selection.path) ?? null)
      : null;
  const openSide: GitSide | null = selection !== null && selection.kind === "file" ? selection.side : null;
  const canHunk =
    diffState.kind === "ready" &&
    !diffState.diff.truncated &&
    !diffState.diff.binary &&
    rows.some((row) => row.kind === "hunk") &&
    openFile !== null &&
    openFile.conflict === null;
  const hunkActions: HunkActions = canHunk && selection !== null && selection.kind === "file" && openSide !== null
    ? (hunk: number) => (
        <span class="gv-hunk-btns">
          {openSide === "worktree" ? (
            <button class="gv-mini" disabled={store.busy} title="只暂存这一块" onClick={() => void store.hunk(selection.path, openSide, hunk, "stage")}>
              暂存
            </button>
          ) : (
            <button class="gv-mini" disabled={store.busy} title="从索引中撤出这一块" onClick={() => void store.hunk(selection.path, openSide, hunk, "unstage")}>
              取消暂存
            </button>
          )}
          {selection.untracked ? null : (
            <button
              class="gv-mini danger"
              disabled={store.busy}
              title="丢弃这一块"
              onClick={() =>
                store.requestDiscardFile(
                  selection.path,
                  openSide,
                  hunk,
                  `丢弃 ${selection.path} 的这一个改动块？`,
                )
              }
            >
              丢弃
            </button>
          )}
        </span>
      )
    : null;

  return (
    <main class="gv">
      <header class="gv-head">
        <span class="gv-head-title">Git</span>
        {status === null ? null : (
          <span class="gv-branch">
            {status.detached ? "detached HEAD" : (status.branch ?? "（未命名分支）")}
            {status.unborn ? "（无提交）" : ""}
            {status.upstream === null ? "" : ` → ${status.upstream}`}
            {status.ahead === 0 && status.behind === 0 ? "" : `  ↑${status.ahead} ↓${status.behind}`}
          </span>
        )}
        <span class="gv-head-spacer" />
        <button class="gv-head-btn" title="刷新" onClick={() => void store.refreshStatus()}>
          刷新
        </button>
        <button class="gv-head-btn" title="关闭（Esc）" onClick={onClose}>
          关闭
        </button>
      </header>

      {store.notice === null ? null : (
        <div class={`gv-notice${store.notice.level === "error" ? " err" : ""}`}>{store.notice.text}</div>
      )}

      {store.status.kind === "loading" ? (
        <p class="gv-empty pad">读取仓库…</p>
      ) : store.status.kind === "error" ? (
        <div class="gv-setup">
          <p class="gv-setup-text">{setupMessage(store.status.error, store.status.code)}</p>
          <p class="gv-setup-detail">{store.status.error}</p>
          <button class="gv-head-btn" onClick={() => void store.refreshStatus()}>
            重试
          </button>
        </div>
      ) : (
        <div class="gv-body">
          <aside class="gv-side">
            <GitCommitBox store={store} status={store.status.status} />
            <GitChanges store={store} status={store.status.status} />
          </aside>

          <aside class="gv-history">
            <GitHistory store={store} />
          </aside>

          <div class="gv-main">
            {selection === null ? (
              <p class="gv-empty pad">选择一个文件或一次提交查看 diff</p>
            ) : (
              <>
                <div class="gv-main-head">
                  {selection.kind === "commit" ? (
                    <span class="gv-main-title">
                      <span class="gv-commit-sha">{selection.commit.short}</span>
                      <span class="gv-main-subject">{selection.commit.subject}</span>
                      <span class="gv-main-meta">
                        {selection.commit.author} · {selection.commit.date}
                      </span>
                    </span>
                  ) : (
                    <>
                      <span class="gv-main-title" title={selection.path}>
                        {selection.path}
                      </span>
                      <span class="gv-chip">{openSide === "index" ? "已暂存" : "工作区"}</span>
                      {openFile !== null && openFile.conflict !== null ? <span class="gv-chip warn">冲突</span> : null}
                      <span class="gv-head-spacer" />
                      {openFile === null || openFile.conflict !== null ? null : (
                        <span class="gv-main-actions">
                          {openSide === "worktree" ? (
                            <button class="gv-mini" disabled={store.busy} onClick={() => void store.stage([selection.path])}>
                              {openFile.untracked ? "跟踪文件" : "暂存文件"}
                            </button>
                          ) : (
                            <button class="gv-mini" disabled={store.busy} onClick={() => void store.unstage([selection.path])}>
                              取消暂存
                            </button>
                          )}
                          <button
                            class="gv-mini danger"
                            disabled={store.busy}
                            onClick={() => {
                              const scope = openFile.untracked ? "untracked" : openSide === "index" ? "all" : "worktree";
                              const verb = openFile.untracked ? "删除" : "丢弃";
                              store.requestDiscard([selection.path], scope, `${verb} ${selection.path} 的改动？`);
                            }}
                          >
                            {openFile.untracked ? "删除文件" : "丢弃改动"}
                          </button>
                        </span>
                      )}
                      <button
                        class="gv-mini"
                        title={store.context === "full" ? "只看改动前后的几行" : "载入完整上下文（可折叠）"}
                        onClick={() => store.setContext(store.context === "full" ? "small" : "full")}
                      >
                        {store.context === "full" ? "3 行上下文" : "完整上下文"}
                      </button>
                    </>
                  )}
                </div>
                {diffState.kind === "ready" && diffState.diff.truncated ? (
                  <div class="gv-banner">patch 超过 1 MB，已截断；按块操作已禁用。</div>
                ) : null}
                {diffState.kind === "ready" && diffState.diff.binary ? (
                  <p class="gv-empty pad">二进制文件没有文本 diff。</p>
                ) : diffState.kind === "loading" ? (
                  <p class="gv-empty pad">读取 diff…</p>
                ) : diffState.kind === "error" ? (
                  <p class="gv-empty pad err">{diffState.error}</p>
                ) : diffState.kind === "ready" && rows.length === 0 ? (
                  <p class="gv-empty pad">没有差异。</p>
                ) : diffState.kind === "ready" ? (
                  <GitDiffView
                    rows={rows}
                    path={selection.kind === "commit" ? "" : selection.path}
                    hunkActions={hunkActions}
                  />
                ) : null}
              </>
            )}
          </div>
        </div>
      )}

      {store.confirm === null ? null : (
        <div class="gv-modal-backdrop" onClick={() => store.cancelConfirm()}>
          <div class="gv-modal" onClick={(event) => event.stopPropagation()}>
            <p class="gv-modal-text">{store.confirm.message}</p>
            <div class="gv-modal-actions">
              <button class="gv-head-btn" onClick={() => store.cancelConfirm()}>
                取消
              </button>
              <button class="gv-danger" onClick={() => store.confirmPending()}>
                {store.confirm.label}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}