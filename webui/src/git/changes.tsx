// Changed-file list of the Git view: conflicts, staged, worktree changes and
// untracked files, each row a click target for the diff pane and each group
// carrying the bulk action that applies to it.
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { GitFile, GitSide, GitStatus } from "../../bridge/git/types";
import type { GitStore } from "./store";

type Group = {
  key: string;
  title: string;
  /** Side of the diff a row in this group opens; null for conflicts. */
  side: GitSide | null;
  files: GitFile[];
};

function groupsOf(status: GitStatus): Group[] {
  const conflicts: GitFile[] = [];
  const staged: GitFile[] = [];
  const changed: GitFile[] = [];
  const untracked: GitFile[] = [];
  for (const file of status.files) {
    if (file.conflict !== null) conflicts.push(file);
    else if (file.untracked) untracked.push(file);
    else {
      if (file.index !== ".") staged.push(file);
      if (file.worktree !== ".") changed.push(file);
    }
  }
  return [
    { key: "conflicts", title: "冲突", side: null, files: conflicts },
    { key: "staged", title: "已暂存", side: "index", files: staged },
    { key: "changes", title: "改动", side: "worktree", files: changed },
    { key: "untracked", title: "未跟踪", side: "worktree", files: untracked },
  ];
}

/** `dir/` dimmed, `file` bright: the tail is what the user is looking for. */
function pathParts(path: string): { dir: string; name: string } {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? { dir: "", name: path } : { dir: path.slice(0, cut + 1), name: path.slice(cut + 1) };
}

export function GitChanges({ store, status }: { store: GitStore; status: GitStatus }): JSX.Element {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const groups = groupsOf(status).filter((group) => group.files.length > 0);
  const busy = store.busy;
  const selection = store.selection;

  const toggle = (key: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (groups.length === 0) {
    return <p class="gv-empty">工作区干净</p>;
  }

  return (
    <div class="gv-changes">
      {groups.map((group) => {
        const paths = group.files.map((file) => file.path);
        const isCollapsed = collapsed.has(group.key);
        return (
          <section class="gv-group" key={group.key}>
            <div class="gv-group-head">
              <button class="gv-group-toggle" onClick={() => toggle(group.key)} title={isCollapsed ? "展开" : "折叠"}>
                <span class={`gv-caret${isCollapsed ? "" : " open"}`}>▸</span>
                <span class="gv-group-title">{group.title}</span>
                <span class="gv-badge">{group.files.length}</span>
              </button>
              <div class="gv-group-actions">
                {group.key === "changes" || group.key === "untracked" ? (
                  <button class="gv-mini" disabled={busy} title="暂存全部" onClick={() => void store.stage(paths)}>
                    暂存全部
                  </button>
                ) : null}
                {group.key === "staged" ? (
                  <button class="gv-mini" disabled={busy} title="取消暂存全部" onClick={() => void store.unstage(paths)}>
                    取消暂存
                  </button>
                ) : null}
                {group.key === "changes" ? (
                  <button
                    class="gv-mini danger"
                    disabled={busy}
                    title="丢弃全部改动"
                    onClick={() => store.requestDiscard(paths, "worktree", `丢弃 ${paths.length} 个文件的改动？`)}
                  >
                    丢弃
                  </button>
                ) : null}
                {group.key === "untracked" ? (
                  <button
                    class="gv-mini danger"
                    disabled={busy}
                    title="删除全部未跟踪文件"
                    onClick={() => store.requestDiscard(paths, "untracked", `删除 ${paths.length} 个未跟踪文件？`)}
                  >
                    删除
                  </button>
                ) : null}
              </div>
            </div>
            {isCollapsed
              ? null
              : group.files.map((file) => {
                  const { dir, name } = pathParts(file.path);
                  const side = group.side;
                  const active =
                    selection !== null &&
                    selection.kind === "file" &&
                    selection.path === file.path &&
                    side !== null &&
                    selection.side === side;
                  return (
                    <div
                      class={`gv-file${active ? " active" : ""}${group.key === "conflicts" ? " conflict" : ""}`}
                      key={`${group.key}:${file.path}`}
                      role="button"
                      tabIndex={0}
                      title={file.origPath === null ? file.path : `${file.origPath} → ${file.path}`}
                      onClick={() => {
                        if (side !== null) store.selectFile(file, side);
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        if (side !== null) store.selectFile(file, side);
                      }}
                    >
                      <span class="gv-code">{group.key === "conflicts" ? "!" : file.worktree === "." ? file.index : file.worktree}</span>
                      <span class="gv-path">
                        <span class="gv-dir">{dir}</span>
                        {name}
                      </span>
                      {file.add !== null || file.del !== null ? (
                        <span class="gv-stats">
                          {file.add !== null && file.add > 0 ? <span class="gv-add-count">+{file.add}</span> : null}
                          {file.del !== null && file.del > 0 ? <span class="gv-del-count">−{file.del}</span> : null}
                        </span>
                      ) : null}
                      {side === null ? null : (
                        <span class="gv-row-actions">
                          {side === "worktree" ? (
                            <button
                              class="gv-mini"
                              disabled={busy}
                              title="暂存"
                              onClick={(event) => {
                                event.stopPropagation();
                                void store.stage([file.path]);
                              }}
                            >
                              {file.untracked ? "跟踪" : "暂存"}
                            </button>
                          ) : (
                            <button
                              class="gv-mini"
                              disabled={busy}
                              title="取消暂存"
                              onClick={(event) => {
                                event.stopPropagation();
                                void store.unstage([file.path]);
                              }}
                            >
                              取消
                            </button>
                          )}
                          <button
                            class="gv-mini danger"
                            disabled={busy}
                            title={group.key === "untracked" ? "删除文件" : side === "index" ? "丢弃已暂存改动" : "丢弃改动"}
                            onClick={(event) => {
                              event.stopPropagation();
                              const scope = group.key === "untracked" ? "untracked" : side === "index" ? "all" : "worktree";
                              const verb = group.key === "untracked" ? "删除" : "丢弃";
                              store.requestDiscard([file.path], scope, `${verb} ${file.path} 的改动？`);
                            }}
                          >
                            {group.key === "untracked" ? "删除" : "丢弃"}
                          </button>
                        </span>
                      )}
                    </div>
                  );
                })}
          </section>
        );
      })}
    </div>
  );
}