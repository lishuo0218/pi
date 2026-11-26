// History column of the Git view: a scope select and a literal search above a
// paged, newest-first commit list. Each row carries its graph lane, the subject
// with ref badges, the short sha and the author/date; copy actions appear on the
// row itself. The tail sentinel loads the next page as it scrolls into view, so
// paging needs no button, and the arrow keys / j k walk the loaded list.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import type { GitCommit, GitRef } from "../../bridge/git/types";
import { CopyButton } from "../copy-button";
import { laneCell, reserveColumns, ROW_HEIGHT } from "./lane-graph";
import { laneSpan, layoutLanes, type LaneRow } from "./lanes";
import type { GitScope, GitStore } from "./store";

/** Badges that fit before the rest collapse into `+n`. */
const REFS_SHOWN = 2;
/** Lane colors are the eight `--c-lane-*` tokens, reused in order. */
const LANE_COLORS = 8;
/** Typing pause before the search walks history again. */
const SEARCH_DEBOUNCE_MS = 250;

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

function scopeValue(scope: GitScope): string {
  if (scope.kind === "head") return "head";
  if (scope.kind === "all") return "all";
  return `ref:${scope.name}`;
}

function scopeOf(value: string): GitScope {
  if (value === "all") return { kind: "all" };
  if (value.startsWith("ref:")) return { kind: "ref", name: value.slice("ref:".length) };
  return { kind: "head" };
}

export function GitHistory({ store }: { store: GitStore }): JSX.Element {
  const state = store.history;
  const [query, setQuery] = useState(store.historyQuery);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const tailRef = useRef<HTMLDivElement | null>(null);
  // A search walks a filtered window, where a commit's parents are usually not
  // loaded at all: lanes would be one column per commit that never resolves, so
  // the rows fall back to a plain node column.
  const searching = store.historyQuery !== "";
  const layout = useMemo(() => (searching ? null : layoutLanes(store.commits)), [store.commits, searching]);
  // The window's own need, not a constant: a linear history keeps the gap to the
  // subject small, and a walk only ever widens as pages land.
  const columns = layout === null ? 1 : reserveColumns(laneSpan(layout));
  const activeSha =
    store.selection !== null && store.selection.kind === "commit" ? store.selection.commit.sha : null;

  // Mounted once with the view, so the first page loads here.
  useEffect(() => {
    if (store.history.kind === "idle") void store.loadHistory(false);
  }, [store]);

  // The input owns the text; the walk starts after typing settles.
  useEffect(() => {
    if (query === store.historyQuery) return;
    const timer = window.setTimeout(() => void store.setHistoryQuery(query), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, store, store.historyQuery]);

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

  // Keyboard walking selects as it moves, so the right pane follows the cursor.
  useEffect(() => {
    if (activeSha === null) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-sha="${activeSha}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [activeSha]);

  const onKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLDivElement>): void => {
    const index = activeSha === null ? -1 : store.commits.findIndex((commit) => commit.sha === activeSha);
    const move = (to: number): void => {
      const commit = store.commits[Math.max(0, Math.min(store.commits.length - 1, to))];
      if (commit !== undefined) store.selectCommit(commit);
    };
    switch (event.key) {
      case "ArrowDown":
      case "j":
        event.preventDefault();
        move(index + 1);
        return;
      case "ArrowUp":
      case "k":
        event.preventDefault();
        move(index <= 0 ? 0 : index - 1);
        return;
      case "Home":
        event.preventDefault();
        move(0);
        return;
      case "End":
        event.preventDefault();
        move(store.commits.length - 1);
        return;
      case "Enter": {
        event.preventDefault();
        const commit =
          activeSha === null
            ? store.commits[0]
            : store.commits.find((candidate) => candidate.sha === activeSha);
        if (commit !== undefined) store.selectCommit(commit);
        return;
      }
      case "/":
        event.preventDefault();
        searchRef.current?.focus();
        return;
      default:
        return;
    }
  };

  const refs = store.refs;
  const status = store.readyStatus;
  const headLabel =
    status === null
      ? "当前分支"
      : status.detached
        ? "当前 HEAD（游离）"
        : status.branch === null
          ? "当前分支"
          : `当前分支（${status.branch}）`;

  return (
    <aside class="gv-history">
      <div class="gv-history-head">
        <select
          class="gv-scope"
          value={scopeValue(store.scope)}
          title="历史范围：一个 ref、当前 HEAD 或全部分支"
          onChange={(event) => store.setScope(scopeOf(event.currentTarget.value))}
        >
          <option value="head">{headLabel}</option>
          <option value="all">全部分支</option>
          {refs === null ? null : (
            <>
              {refs.local.length === 0 ? null : (
                <optgroup label="本地分支">
                  {refs.local.map((name) => (
                    <option key={`refs/heads/${name}`} value={`ref:refs/heads/${name}`}>
                      {name}
                    </option>
                  ))}
                </optgroup>
              )}
              {refs.remote.length === 0 ? null : (
                <optgroup label="远程跟踪分支">
                  {refs.remote.map((name) => (
                    <option key={`refs/remotes/${name}`} value={`ref:refs/remotes/${name}`}>
                      {name}
                    </option>
                  ))}
                </optgroup>
              )}
              {refs.tag.length === 0 ? null : (
                <optgroup label="标签">
                  {refs.tag.map((name) => (
                    <option key={`refs/tags/${name}`} value={`ref:refs/tags/${name}`}>
                      {name}
                    </option>
                  ))}
                </optgroup>
              )}
            </>
          )}
        </select>
        <div class="gv-search">
          <input
            ref={searchRef}
            class="gv-search-input"
            type="search"
            value={query}
            placeholder="搜索提交 / 作者 / sha"
            spellcheck={false}
            data-esc="clear"
            onInput={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setQuery("");
                void store.setHistoryQuery("");
              }
              if (event.key === "Enter") void store.setHistoryQuery(query);
            }}
          />
        </div>
      </div>

      <div class="gv-history-body" tabIndex={0} onKeyDown={onKeyDown}>
        {state.kind === "loading" ? (
          <p class="gv-empty">加载历史…</p>
        ) : state.kind === "error" ? (
          <p class="gv-empty err">{state.error}</p>
        ) : store.commits.length === 0 ? (
          <p class="gv-empty">{store.historyQuery === "" ? "还没有提交" : "没有匹配的提交"}</p>
        ) : (
          <div class="gv-log" ref={listRef}>
            {store.commits.map((commit, index) => (
              <GitCommitRow
                key={commit.sha}
                commit={commit}
                row={layout === null ? null : (layout[index] ?? null)}
                columns={columns}
                active={commit.sha === activeSha}
                store={store}
              />
            ))}
            <div class="gv-log-tail" ref={tailRef}>
              {store.loadingMore ? "加载中…" : ""}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

/** Color of one lane, wrapping after the palette's eight tokens. */
function laneColor(lane: number): string {
  return `var(--c-lane-${(lane % LANE_COLORS) + 1})`;
}

/**
 * Graph cell of one row. The shapes come from `laneCell`, so this stays a plain
 * assembly of the paths and the node in the lane's color.
 */
function LaneGraph({ row, columns, active }: { row: LaneRow | null; columns: number; active: boolean }): JSX.Element {
  const cell = laneCell(row, columns);
  const lane = row === null ? 0 : row.lane;
  const viewBox = `0 0 ${cell.width} ${ROW_HEIGHT}`;
  return (
    <svg class="gv-lane" width={cell.width} height={ROW_HEIGHT} viewBox={viewBox} aria-hidden="true">
      {cell.paths.map((path, index) => (
        <path key={index} class="gv-lane-line" style={{ stroke: laneColor(path.lane) }} d={path.d} />
      ))}
      <circle
        class={`gv-lane-node${active ? " active" : ""}`}
        style={{ fill: laneColor(lane) }}
        cx={cell.node.x}
        cy={cell.node.y}
        r={active ? 3.5 : 2.5}
      />
    </svg>
  );
}

/** One history row: the selection lives in the store, so the row only renders. */
function GitCommitRow({
  commit,
  row,
  columns,
  active,
  store,
}: {
  commit: GitCommit;
  row: LaneRow | null;
  columns: number;
  active: boolean;
  store: GitStore;
}): JSX.Element {
  const { shown, extra } = visibleRefs(commit.refs);
  const open = (): void => store.selectCommit(commit);
  return (
    <div
      class={`gv-commit${active ? " active" : ""}`}
      role="button"
      tabIndex={-1}
      data-sha={commit.sha}
      title={`${commit.sha}\n${commit.author}  ${commit.date}\n\n${commit.subject}`}
      onClick={(event) => {
        // Focus follows the click, so the arrow keys keep walking the list.
        event.currentTarget.focus();
        open();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        open();
      }}
    >
      <LaneGraph row={row} columns={columns} active={active} />
      <span class="gv-commit-text">
        <span class="gv-commit-line">
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
        <span class="gv-commit-line meta">
          <span class="gv-commit-sha">{commit.short}</span>
          <span class="gv-commit-extra">
            {commit.author} · {commit.date}
          </span>
          <span class="gv-commit-actions" onClick={(event) => event.stopPropagation()}>
            <CopyButton class="gv-mini" text={commit.sha} label="sha" />
            <CopyButton class="gv-mini" text={commit.subject} label="标题" />
          </span>
        </span>
      </span>
    </div>
  );
}