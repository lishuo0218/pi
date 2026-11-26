// Width of the left session sidebar. The sidebar is dragged on its right edge
// and the width is remembered across sessions. Module-level (same pattern as
// panel-width.ts) so the drag handle and the layout both read one value.
const STORAGE_KEY = "pi-web-sidebar-width";
const DEFAULT_WIDTH = 260;
const MIN_WIDTH = 200;
const MAX_WIDTH = 460;

const listeners = new Set<() => void>();
let width = load();

/** Keeps the sidebar usable and leaves the conversation some room. */
function clamp(px: number): number {
  const max = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, window.innerWidth - 480));
  return Math.round(Math.min(Math.max(px, MIN_WIDTH), max));
}

/** Stored width, clamped; the default when nothing was stored yet. */
function load(): number {
  const raw = localStorage.getItem(STORAGE_KEY);
  const px = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(px) ? clamp(px) : DEFAULT_WIDTH;
}

/** Sidebar width in CSS pixels. */
export function getSidebarWidth(): number {
  return width;
}

/** Resize the sidebar; the stored value follows on save. */
export function setSidebarWidth(px: number): void {
  const next = clamp(px);
  if (next === width) return;
  width = next;
  for (const fn of listeners) fn();
}

/** Persist the current width, so the next visit opens at the same size. */
export function saveSidebarWidth(): void {
  localStorage.setItem(STORAGE_KEY, String(width));
}

/** Subscribe to width changes; returns an unsubscribe function. */
export function onSidebarWidthChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}