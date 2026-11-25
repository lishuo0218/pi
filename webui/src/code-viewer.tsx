// Code body of the file preview: a virtualized line list with syntax
// highlighting, a find bar (Ctrl+F) and a word-wrap toggle. Only the rows near
// the viewport are rendered, so the 1 MB cap is the only limit on file size.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { markedLineHtml, type LineRun } from "./highlight";
import { useVirtualLines } from "./virtual-lines";

/** Row height in CSS pixels; must match .viewer-row in style.css. */
const LINE_HEIGHT = 18;
/** Longer lines skip hljs: one minified 1 MB line would stall the panel. */
const MAX_HIGHLIGHT = 4000;

/** One occurrence of the query: a half-open character range on a line. */
type Hit = { line: number; start: number; end: number };

/** Case-insensitive text search, in reading order. */
function findHits(lines: string[], query: string): Hit[] {
  if (query === "") return [];
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  const hits: Hit[] = [];
  for (let line = 0; line < lines.length; line++) {
    for (const match of (lines[line] ?? "").matchAll(pattern)) {
      hits.push({ line, start: match.index, end: match.index + match[0].length });
    }
  }
  return hits;
}

/** Runs covering a whole line, with each hit as one marked run. */
function hitRuns(text: string, hits: { start: number; end: number; index: number }[], current: number): LineRun[] {
  const runs: LineRun[] = [];
  let at = 0;
  for (const hit of hits) {
    if (hit.start > at) runs.push({ text: text.slice(at, hit.start), cls: null });
    runs.push({ text: text.slice(hit.start, hit.end), cls: hit.index === current ? "search-hit current" : "search-hit" });
    at = hit.end;
  }
  if (at < text.length) runs.push({ text: text.slice(at), cls: null });
  return runs;
}

export function CodeViewer({ lines, lang, wrap, onWrapChange, initialFind = false }: {
  lines: string[];
  lang: string | undefined;
  wrap: boolean;
  onWrapChange: (wrap: boolean) => void;
  /** Opens the find bar on mount, for markdown files searched from the preview. */
  initialFind?: boolean;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const [findOpen, setFindOpen] = useState(initialFind);
  const [current, setCurrent] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const hits = useMemo(() => findHits(lines, query), [lines, query]);
  // Indexed by line so a rendered row needs no scan of all hits.
  const byLine = useMemo(() => {
    const map = new Map<number, { start: number; end: number; index: number }[]>();
    hits.forEach((hit, index) => {
      const entry = { start: hit.start, end: hit.end, index };
      const list = map.get(hit.line);
      if (list === undefined) map.set(hit.line, [entry]);
      else list.push(entry);
    });
    return map;
  }, [hits]);

  const activeIndex = hits.length === 0 ? 0 : Math.min(current, hits.length - 1);
  const virtual = useVirtualLines(lines.length, wrap, LINE_HEIGHT);

  useEffect(() => {
    const hit = hits[activeIndex];
    if (hit !== undefined) virtual.scrollToIndex(hit.line);
  }, [hits, activeIndex]);

  const step = (delta: number): void => {
    if (hits.length === 0) return;
    setCurrent((prev) => (prev + delta + hits.length) % hits.length);
  };

  // Capture phase: Esc must close the find bar instead of aborting the run, and
  // Ctrl+F must open the bar instead of reaching the browser.
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
        event.stopPropagation();
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

  const rows: JSX.Element[] = [];
  for (let line = virtual.start; line < virtual.end; line++) {
    const text = lines[line] ?? "";
    const marks = byLine.get(line);
    const runs = marks === undefined ? [] : hitRuns(text, marks, activeIndex);
    const lineLang = text.length > MAX_HIGHLIGHT ? undefined : lang;
    rows.push(
      <div key={line} class="viewer-row" data-line={line}>
        <span class="viewer-num">{line + 1}</span>
        <span class="viewer-text" dangerouslySetInnerHTML={{ __html: markedLineHtml(text, lineLang, runs) }} />
      </div>,
    );
  }

  return (
    <section class={`viewer${wrap ? " wrap" : ""}`}>
      <div class="viewer-bar">
        <button class={`viewer-btn${wrap ? " active" : ""}`} title="长行自动换行" onClick={() => onWrapChange(!wrap)}>
          换行
        </button>
        <button class="viewer-btn" title="查找（Ctrl+F）" onClick={() => setFindOpen(true)}>
          查找
        </button>
      </div>
      {findOpen ? (
        <div class="viewer-find">
          <input
            ref={inputRef}
            value={query}
            placeholder="查找…"
            spellcheck={false}
            onInput={(event) => {
              setQuery(event.currentTarget.value);
              setCurrent(0);
            }}
          />
          <span class="viewer-count">{query === "" ? "" : `${activeIndex + 1} / ${hits.length}`}</span>
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
      <div class="viewer-scroll" ref={virtual.scrollRef}>
        <div
          class="viewer-lines"
          ref={virtual.linesRef}
          style={{ height: `${virtual.totalHeight}px`, paddingTop: `${virtual.offset}px` }}
        >
          {rows}
        </div>
      </div>
    </section>
  );
}