// Commit list of the Git view: its own column of paged, newest-first history.
// One row is a short sha over a single-line subject, with branch/remote/tag
// badges on the right; the tail sentinel loads the next page as it scrolls into
// view, so paging needs no button. Unborn branches show an empty state.
import { useEffect, useRef } from "preact/hooks";
import type { JSX } from "preact";
import type { GitCommit, GitRef } from "../../bridge/git/types";
import type { GitStore } from "./store";

/** Badges that fit before the rest collapse into `+n`. */
const REFS_SHOWN = 2;

/** Badge tooltip: the ref kind spelled out, since a badge is only a name. */
function refTitle(ref: GitRef): string {
  if (ref.kind === "tag") return `标签 ${ref.name}`;
  return ref.kind === "remote" ? `远程跟踪分支 ${ref.name}` : `分支 ${ref.name}`;
}

/**
 * The refs worth showing on a row: local branches first, then remotes, then
 * tags, two at most, because a commit can carry a dozen tags.
 */
function visibleRefs(refs: GitRef[]): { shown: GitRef[]; extra: GitRef[] } {
  const order = { branch: 0, remote: 1, tag: 2 };
  const sorted = [...refs].sort((left, right) => order[left.kind] - order[right.kind]);
  return { shown: sorted.slice(0, REFS_SHOWN), extra: sorted.slice(REFS_SHOWN) };
}

export function GitHistory({ store }: { store: GitStore }): JSX.Element {
  const state = store.history;
  const tailRef = useRef<HTMLDivElement | null>(null);

  // Mounted once with the view, so the first page loads here.
  useEffect(() => {
    if (store.history.kind === "idle") void store.loadHistory(false);
  }, [store]);

  // A sentinel instead of a scroll listener: it also fires when the loaded pages
  // do not fill the column yet, so a long history keeps loading without a scroll.
  useEffect(() => {
    const tail = tailRef.current;
    if (tail === null || !store.hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void store.loadHistory(true);
      },
      { rootMargin: "240px" },
    );
    observer.observe(tail);
    return () => observer.disconnect();
  }, [store, state.kind, store.hasMore, store.commits.length]);

  return (
    <aside class="gv-history">
      {state.kind === "loading" ? (
        <p class="gv-empty">加载历史…</p>
      ) : state.kind === "error" ? (
        <p class="gv-empty err">{state.error}</p>
      ) : store.commits.length === 0 ? (
        <p class="gv-empty">还没有提交</p>
      ) : (
        <div class="gv-log">
          {store.commits.map((commit) => (
            <GitCommitRow key={commit.sha} commit={commit} store={store} />
          ))}
          <div class="gv-log-tail" ref={tailRef}>
            {store.loadingMore ? "加载中…" : ""}
          </div>
        </div>
      )}
    </aside>
  );
}

/** One history row: the selection lives in the store, so the row only renders. */
function GitCommitRow({ commit, store }: { commit: GitCommit; store: GitStore }): JSX.Element {
  const selection = store.selection;
  const active = selection !== null && selection.kind === "commit" && selection.commit.sha === commit.sha;
  const { shown, extra } = visibleRefs(commit.refs);
  return (
    <div
      class={`gv-commit${active ? " active" : ""}`}
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
      <span class="gv-commit-title">
        <span class="gv-commit-subject">{commit.subject}</span>
        {shown.length === 0 ? null : (
          <span class="gv-commit-refs">
            {shown.map((ref) => (
              <span class={`gv-ref ${ref.kind}`} key={`${ref.kind}:${ref.name}`} title={refTitle(ref)}>
                {ref.name}
              </span>
            ))}
            {extra.length === 0 ? null : (
              <span class="gv-ref more" title={extra.map((ref) => refTitle(ref)).join("\n")}>
                {`+${extra.length}`}
              </span>
            )}
          </span>
        )}
      </span>
    </div>
  );
}