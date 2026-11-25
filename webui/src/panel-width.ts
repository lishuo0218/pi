// Width of the right panel while a file preview fills it. The panel is dragged
// on its left edge, and the preview width is remembered across sessions; the
// ToDo + file tree view keeps its fixed width. Module-level (same pattern as
// pi-cwd.ts) so the drag handle and the layout both read one value.
const STORAGE_KEY = "pi-web-preview-width";
const DEFAULT_WIDTH = 420;
const MIN_WIDTH = 320;
const MAX_WIDTH = 900;

const listeners = new Set<() => void>();
let width = load();

/** Keeps the panel usable and leaves the message stream some room. */
function clamp(px: number): number {
  const max = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, window.innerWidth - 320));
  return Math.round(Math.min(Math.max(px, MIN_WIDTH), max));
}

/** Stored width, clamped; the default when nothing was stored yet. */
function load(): number {
  const raw = localStorage.getItem(STORAGE_KEY);
  const px = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(px) ? clamp(px) : DEFAULT_WIDTH;
}

/** Preview panel width in CSS pixels. */
export function getPreviewWidth(): number {
  return width;
}

/** Resize the preview panel; the stored value follows on save. */
export function setPreviewWidth(px: number): void {
  const next = clamp(px);
  if (next === width) return;
  width = next;
  for (const fn of listeners) fn();
}

/** Persist the current width, so the next session opens at the same size. */
export function savePreviewWidth(): void {
  localStorage.setItem(STORAGE_KEY, String(width));
}

/** Subscribe to width changes; returns an unsubscribe function. */
export function onPreviewWidthChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}