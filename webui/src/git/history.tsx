// Commit list of the Git view: paged newest-first history, one row per commit
// (sha + subject; the full author and date are in the row's title), and the
// "load more" tail. Unborn branches show an empty state, not an error.
import { useEffect } from "preact/hooks";
import type { JSX } from "preact";
import type { GitStore } from "./store";

export function GitHistory({ store }: { store: GitStore }): JSX.Element {
  const state = store.history;
  // The section is mounted once, with the view, so the first page loads here.
  useEffect(() => {
    if (store.history.kind === "idle") void store.loadHistory(false);
  }, [store]);

  if (state.kind === "loading") return <p class="gv-empty">加载历史…</p>;
  if (state.kind === "error") return <p class="gv-empty err">{state.error}</p>;
  if (state.kind === "idle" || store.commits.length === 0) return <p class="gv-empty">还没有提交</p>;

  const selection = store.selection;
  return (
    <div class="gv-log">
      {store.commits.map((commit) => (
        <div
          class={`gv-commit${selection !== null && selection.kind === "commit" && selection.commit.sha === commit.sha ? " active" : ""}`}
          key={commit.sha}
          role="button"
          tabIndex={0}
          title={`${commit.sha}\n${commit.author}  ${commit.date}\n\n${commit.subject}`}
          onClick={() => store.selectCommit(commit)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            store.selectCommit(commit);
          }}
        >
          <span class="gv-commit-sha">{commit.short}</span>
          <span class="gv-commit-subject">{commit.subject}</span>
        </div>
      ))}
      {store.hasMore ? (
        <button class="gv-more" disabled={store.busy} onClick={() => void store.loadHistory(true)}>
          加载更多
        </button>
      ) : null}
    </div>
  );
}