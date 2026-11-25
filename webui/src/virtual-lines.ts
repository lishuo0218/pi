// Virtual scrolling for the code viewer: only the rows near the viewport exist
// in the DOM, so a 1 MB file scrolls like a small one. Unwrapped rows all have
// the caller's line height and offsets are arithmetic. Wrapped rows are
// measured instead, and a measurement above the viewport shifts scrollTop by
// the same amount, so the text under the cursor does not jump.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";

/** Rows rendered beyond each edge of the viewport. */
const OVERSCAN = 12;

export type VirtualLines = {
  /** Scroll container that holds the list. */
  scrollRef: (el: HTMLDivElement | null) => void;
  /** Box holding the rendered rows; measured after each render while wrapping. */
  linesRef: (el: HTMLDivElement | null) => void;
  /** First rendered row. */
  start: number;
  /** One past the last rendered row. */
  end: number;
  /** Distance from the top of the list to the first rendered row. */
  offset: number;
  /** Height of the whole list. */
  totalHeight: number;
  /** Scrolls so row `index` sits a third of the way down. */
  scrollToIndex: (index: number) => void;
};

export function useVirtualLines(count: number, wrap: boolean, lineHeight: number): VirtualLines {
  const scrollEl = useRef<HTMLDivElement | null>(null);
  const linesEl = useRef<HTMLDivElement | null>(null);
  /** Measured heights while wrapping; a missing entry means one line height. */
  const heights = useRef<number[]>([]);
  /** Prefix sums: sums[i] is the top of row i, length count + 1. */
  const sums = useRef<number[]>([0]);
  const [view, setView] = useState({ start: 0, end: Math.min(count, 40) });
  // Offsets live in refs, so a measurement that changes them needs a render of
  // its own: nothing else about the view changed.
  const [, setVersion] = useState(0);

  /** Rebuild the offset table from the measured heights. */
  const build = (): void => {
    // Wrapped rows are measured lazily, so unmeasured ones use the average
    // measured height: a long jump then lands near the target, not far above it.
    let sum = 0;
    let seen = 0;
    if (wrap) {
      for (let i = 0; i < count; i++) {
        const height = heights.current[i];
        if (height !== undefined) {
          sum += height;
          seen += 1;
        }
      }
    }
    const estimate = seen === 0 ? lineHeight : sum / seen;
    const next = new Array<number>(count + 1);
    next[0] = 0;
    for (let i = 0; i < count; i++) {
      next[i + 1] = (next[i] ?? 0) + (wrap ? (heights.current[i] ?? estimate) : lineHeight);
    }
    sums.current = next;
  };

  const offsetOf = (index: number): number => sums.current[Math.min(Math.max(index, 0), count)] ?? 0;

  /** Row whose top is at or above `y`. */
  const indexAt = (y: number): number => {
    let lo = 0;
    let hi = count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((sums.current[mid] ?? 0) <= y) lo = mid;
      else hi = mid - 1;
    }
    return Math.max(lo, 0);
  };

  const refresh = (): void => {
    const el = scrollEl.current;
    if (!el) return;
    const top = el.scrollTop;
    const start = Math.max(0, indexAt(top) - OVERSCAN);
    const end = Math.min(count, indexAt(top + el.clientHeight) + 1 + OVERSCAN);
    setView((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  };

  // New file, wrap toggled, line height changed: measured heights are stale.
  useLayoutEffect(() => {
    heights.current = [];
    build();
    refresh();
    setVersion((version) => version + 1);
  }, [count, wrap, lineHeight]);

  useEffect(() => {
    const el = scrollEl.current;
    if (!el) return;
    let frame = 0;
    const onScroll = (): void => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        refresh();
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      // A width change rewraps every line, so the measured heights are stale.
      if (wrap && el.clientWidth !== width) {
        width = el.clientWidth;
        heights.current = [];
        build();
        setVersion((version) => version + 1);
      }
      refresh();
    });
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [count, wrap, lineHeight]);

  useLayoutEffect(() => {
    if (!wrap) return;
    const box = linesEl.current;
    const el = scrollEl.current;
    if (!box || !el) return;
    const top = el.scrollTop;
    let shift = 0;
    let changed = false;
    for (const row of box.querySelectorAll<HTMLElement>("[data-line]")) {
      const index = Number(row.dataset.line);
      const height = row.offsetHeight;
      const stored = heights.current[index];
      if (stored === height) continue;
      // Rows above the viewport moved everything below them down or up. A row
      // measured for the first time counts with the height it was laid out at.
      if ((sums.current[index] ?? 0) < top) shift += height - (stored ?? lineHeight);
      // Every measured row is kept, so the average row height used for the
      // rows not measured yet is not biased towards tall ones.
      heights.current[index] = height;
      if (stored !== undefined || height !== lineHeight) changed = true;
    }
    if (!changed) return;
    build();
    if (shift !== 0) el.scrollTop = top + shift;
    setVersion((version) => version + 1);
  });

  const scrollToIndex = useCallback((index: number): void => {
    const el = scrollEl.current;
    if (!el) return;
    const band = Math.round(el.clientHeight / 3);
    el.scrollTop = Math.max(0, offsetOf(index) - band);
    refresh();
    if (!wrap) return;
    // Wrapped rows are measured lazily, so the jump above only knows an average
    // row height. Bisect the scroll position on the rendered row range until the
    // row is on screen, then centre it: one frame per halving.
    let lo = 0;
    let hi = Math.max(0, offsetOf(count) - el.clientHeight);
    let probe = Math.max(0, offsetOf(index) - band);
    let passes = 0;
    const step = (): void => {
      passes += 1;
      if (passes > 24) return;
      const row = linesEl.current?.querySelector<HTMLElement>(`[data-line="${index}"]`);
      if (row !== null && row !== undefined) {
        const delta = row.getBoundingClientRect().top - el.getBoundingClientRect().top - band;
        if (Math.abs(delta) >= 4) {
          el.scrollTop += delta;
          requestAnimationFrame(step);
        }
        return;
      }
      const box = linesEl.current;
      const rows = box === null ? [] : [...box.querySelectorAll<HTMLElement>("[data-line]")];
      if (rows.length === 0 || hi - lo <= 1) return;
      const first = Number(rows[0]?.dataset.line);
      if (index < first) hi = probe;
      else lo = probe;
      if (hi - lo <= 1) return;
      probe = Math.round((lo + hi) / 2);
      el.scrollTop = probe;
      refresh();
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, [count, wrap, lineHeight]);

  const scrollRef = useCallback((el: HTMLDivElement | null): void => {
    scrollEl.current = el;
  }, []);

  const linesRef = useCallback((el: HTMLDivElement | null): void => {
    linesEl.current = el;
  }, []);

  return {
    scrollRef,
    linesRef,
    start: view.start,
    end: view.end,
    offset: offsetOf(view.start),
    totalHeight: offsetOf(count),
    scrollToIndex,
  };
}