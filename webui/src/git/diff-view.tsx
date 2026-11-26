// Diff pane of the Git view: a virtualized, syntax-highlighted line list over
// a parsed patch, with foldable context, a find bar (Ctrl+F), and hunk-level
// stage/unstage/discard buttons on each hunk header.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { langForPath, markedLineHtml, type LineRun } from "../highlight";
import { useVirtualLines } from "../virtual-lines";
import { buildDisplay, displayIndexOf, findHits, type DiffRow, type DisplayRow } from "./diff-parse";
import { fadeSwap } from "../fade-swap";

/** Row height in CSS pixels; must match .gv-line in style.css. */
const LINE_HEIGHT = 18;
/** Longer lines skip hljs; one minified line would stall the pane. */
const MAX_HIGHLIGHT = 4000;

/** One hunk's controls; `null` on a patch that cannot be staged hunk-wise. */
export type HunkActions = ((hunk: number) => JSX.Element | null) | null;

export function GitDiffView({ rows, path, hunkActions }: {
  rows: DiffRow[];
  path: string;
  hunkActions: HunkActions;
}): JSX.Element {
  const [expanded, setExpanded] = useState<ReadonlySet<number> | "all">(new Set<number>());
  const [query, setQuery] = useState("");
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [current, setCurrent] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Fade target for fold toggles: the row list, whose box keeps its height.
  const rowsRef = useRef<HTMLDivElement | null>(null);

  // A new patch (other file, other side, refreshed context) starts folded.
  useEffect(() => {
    setExpanded(new Set<number>());
    setCurrent(0);
  }, [rows]);

  const hits = useMemo(() => findHits(rows, query, { caseSensitive, regex }), [rows, query, caseSensitive, regex]);
  const hitsByRow = useMemo(() => {
    const map = new Map<number, { start: number; end: number; index: number }[]>();
    hits.forEach((hit, index) => {
      const list = map.get(hit.row);
      const entry = { start: hit.start, end: hit.start + hit.length, index };
      if (list === undefined) map.set(hit.row, [entry]);
      else list.push(entry);
    });
    return map;
  }, [hits]);

  const activeIndex = hits.length === 0 ? 0 : Math.min(current, hits.length - 1);
  const activeHit = hits[activeIndex];
  const display = useMemo(() => buildDisplay(rows, expanded), [rows, expanded]);
  const virtual = useVirtualLines(display.length, false, LINE_HEIGHT);
  const lang = langForPath(path);

  // A hit inside a folded run: open the folds, then jump once they exist.
  useEffect(() => {
    if (activeHit === undefined) return;
    const index = displayIndexOf(display, activeHit.row);
    if (index === -1) {
      setExpanded("all");
      return;
    }
    virtual.scrollToIndex(index);
  }, [activeHit, display]);

  const step = (delta: number): void => {
    if (hits.length === 0) return;
    setCurrent((prev) => (prev + delta + hits.length) % hits.length);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setFindOpen(true);
        return;
      }
      if (!findOpen) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        setFindOpen(false);
        setQuery("");
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        step(event.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [findOpen, hits.length]);

  useEffect(() => {
    if (findOpen) inputRef.current?.focus();
  }, [findOpen]);

  // Display rows are contiguous, so the patch row of a display index is a
  // running count from the first rendered row instead of a scan per row.
  let patchRow = 0;
  for (let i = 0; i < virtual.start; i++) {
    if (display[i]?.kind === "row") patchRow += 1;
  }
  const rowsOut: JSX.Element[] = [];
  for (let index = virtual.start; index < virtual.end; index++) {
    const entry = display[index];
    if (entry === undefined) continue;
    if (entry.kind === "fold") {
      rowsOut.push(
        <div key={`fold-${entry.id}`} class="gv-line gv-fold" data-line={index}>
          <span class="gv-num" />
          <span class="gv-num" />
          <span class="gv-mark" />
          <button
            class="gv-fold-btn"
            title="展开未改动的行"
            onClick={() => {
              fadeSwap(rowsRef.current, () => {
                setExpanded((prev) => {
                  const next = new Set(prev === "all" ? [] : prev);
                  next.add(entry.id);
                  return next;
                });
              });
            }}
          >
            ⋯ {entry.count} 行未改动
          </button>
        </div>,
      );
      continue;
    }
    const row = entry.row;
    const rowIndex = patchRow++;
    if (row.kind === "hunk") {
      rowsOut.push(
        <div key={index} class="gv-line gv-hunk" data-line={index}>
          <span class="gv-num" />
          <span class="gv-num" />
          <span class="gv-mark" />
          <span class="gv-text">{row.text}</span>
          {hunkActions === null ? null : <span class="gv-hunk-actions">{hunkActions(row.hunk)}</span>}
        </div>,
      );
      continue;
    }
    if (row.kind === "meta" || row.kind === "note") {
      rowsOut.push(
        <div key={index} class="gv-line" data-line={index}>
          <span class="gv-num" />
          <span class="gv-num" />
          <span class="gv-mark" />
          <span class="gv-text gv-dim">{row.text}</span>
        </div>,
      );
      continue;
    }
    const marks = hitsByRow.get(rowIndex);
    const runs: LineRun[] = [];
    if (marks !== undefined) {
      let at = 0;
      for (const mark of marks) {
        if (mark.start > at) runs.push({ text: row.text.slice(at, mark.start), cls: null });
        runs.push({ text: row.text.slice(mark.start, mark.end), cls: mark.index === activeIndex ? "search-hit current" : "search-hit" });
        at = mark.end;
      }
      if (at < row.text.length) runs.push({ text: row.text.slice(at), cls: null });
    }
    const oldText = row.kind === "ctx" ? String(row.old) : row.kind === "del" ? String(row.old) : "";
    const newText = row.kind === "ctx" ? String(row.new) : row.kind === "add" ? String(row.new) : "";
    const mark = row.kind === "add" ? "+" : row.kind === "del" ? "-" : " ";
    const cls = row.kind === "add" ? "gv-add" : row.kind === "del" ? "gv-del" : "gv-ctx";
    rowsOut.push(
      <div key={index} class={`gv-line ${cls}`} data-line={index}>
        <span class="gv-num">{oldText}</span>
        <span class="gv-num">{newText}</span>
        <span class="gv-mark">{mark}</span>
        <span
          class="gv-text"
          dangerouslySetInnerHTML={{
            __html: markedLineHtml(row.text, row.text.length > MAX_HIGHLIGHT ? undefined : lang, runs),
          }}
        />
      </div>,
    );
  }

  const foldsOpen = expanded === "all" || expanded.size > 0;
  return (
    <section class="gv-diff">
      <div class="viewer-bar">
        <button
          class={`viewer-btn${foldsOpen ? " active" : ""}`}
          title={foldsOpen ? "折叠未改动区域" : "展开未改动区域"}
          onClick={() =>
            fadeSwap(rowsRef.current, () =>
              setExpanded((prev) => (prev === "all" || prev.size > 0 ? new Set<number>() : "all")),
            )
          }
        >
          {foldsOpen ? "折叠未改动" : "展开未改动"}
        </button>
        <button class="viewer-btn" title="查找（Ctrl+F）" onClick={() => setFindOpen(true)}>
          查找
        </button>
        <span class="gv-count">{rows.length} 行</span>
      </div>
      {findOpen ? (
        <div class="viewer-find">
          <input
            ref={inputRef}
            value={query}
            placeholder="在 diff 中查找…"
            spellcheck={false}
            onInput={(event) => {
              setQuery(event.currentTarget.value);
              setCurrent(0);
            }}
          />
          <span class="viewer-count">{query === "" ? "" : `${activeIndex + 1} / ${hits.length}`}</span>
          <button
            class={`viewer-btn${caseSensitive ? " active" : ""}`}
            title="区分大小写"
            onClick={() => setCaseSensitive((prev) => !prev)}
          >
            Aa
          </button>
          <button class={`viewer-btn${regex ? " active" : ""}`} title="正则表达式" onClick={() => setRegex((prev) => !prev)}>
            .*
          </button>
          <button class="viewer-btn" title="上一个（Shift+Enter）" disabled={hits.length === 0} onClick={() => step(-1)}>
            ↑
          </button>
          <button class="viewer-btn" title="下一个（Enter）" disabled={hits.length === 0} onClick={() => step(1)}>
            ↓
          </button>
          <button
            class="viewer-btn"
            title="关闭查找（Esc）"
            onClick={() => {
              setFindOpen(false);
              setQuery("");
            }}
          >
            ✕
          </button>
        </div>
      ) : null}
      <div class="viewer-scroll gv-scroll" ref={virtual.scrollRef}>
        <div
          class="gv-lines"
          ref={(el) => {
            virtual.linesRef(el);
            rowsRef.current = el;
          }}
          style={{ height: `${virtual.totalHeight}px`, paddingTop: `${virtual.offset}px` }}
        >
          {rowsOut}
        </div>
      </div>
    </section>
  );
}
