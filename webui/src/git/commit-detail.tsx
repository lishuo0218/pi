// Commit strip above the patch: author, date, parent links and the commit's file
// list with line counts. Choosing a file there narrows the pane from the whole
// commit patch to that one file; "全部改动" goes back.
import type { JSX } from "preact";
import { CopyButton } from "../copy-button";
import { pathParts } from "./path-parts";
import type { GitStore } from "./store";

export function GitCommitDetail({ store }: { store: GitStore }): JSX.Element | null {
  const selection = store.selection;
  if (selection === null || selection.kind !== "commit") return null;
  const detail = store.detail;
  const ready = detail.kind === "ready" ? detail.detail : null;
  const commit = ready?.commit ?? selection.commit;
  const stats = ready === null || ready.stats.files === 0 ? null : ready.stats;

  return (
    <div class="gv-detail">
      <div class="gv-detail-meta">
        <span class="gv-detail-author">{commit.author}</span>
        <span class="gv-detail-date">{commit.date}</span>
        {commit.parents.length === 0 ? null : (
          <span class="gv-detail-parents">
            父
            {commit.parents.map((parent) => (
              <button
                class="gv-link"
                key={parent}
                title={`打开提交 ${parent}`}
                onClick={() => void store.openCommit(parent)}
              >
                {parent.slice(0, 7)}
              </button>
            ))}
          </span>
        )}
        {stats === null ? null : (
          <span class="gv-detail-stats">
            {stats.files} 个文件
            {stats.add === 0 ? null : <span class="gv-add-count">+{stats.add}</span>}
            {stats.del === 0 ? null : <span class="gv-del-count">−{stats.del}</span>}
          </span>
        )}
        <span class="gv-detail-spacer" />
        {detail.kind === "loading" ? <span class="gv-detail-loading">读取详情…</span> : null}
        <CopyButton class="gv-mini" text={selection.commit.sha} label="sha" />
      </div>
      {detail.kind === "error" ? <p class="gv-detail-error">{detail.error}</p> : null}
      {ready === null || ready.files.length === 0 ? null : (
        <div class="gv-detail-files">
          <button
            class={`gv-detail-file all${selection.file === null ? " active" : ""}`}
            onClick={() => store.selectCommitFile(null)}
          >
            全部改动
          </button>
          {ready.files.map((file) => {
            const { dir, name } = pathParts(file.path);
            return (
              <button
                class={`gv-detail-file${selection.file === file.path ? " active" : ""}`}
                key={file.path}
                title={file.path}
                onClick={() => store.selectCommitFile(file.path)}
              >
                <span class="gv-path">
                  <span class="gv-dir">{dir}</span>
                  {name}
                </span>
                <span class="gv-stats">
                  {file.add === null || file.add === 0 ? null : <span class="gv-add-count">+{file.add}</span>}
                  {file.del === null || file.del === 0 ? null : <span class="gv-del-count">−{file.del}</span>}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}