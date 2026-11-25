// Global diff layout preference for edit tool cards: unified (single column)
// or split (old left / new right). Persisted in localStorage so every card,
// current and future, follows one choice; listeners re-render open cards.
export type DiffLayout = "unified" | "split";

const STORAGE_KEY = "pi-web-diff-layout";

let current: DiffLayout = readLayout();
const listeners = new Set<() => void>();

function readLayout(): DiffLayout {
  try {
    return localStorage.getItem(STORAGE_KEY) === "split" ? "split" : "unified";
  } catch {
    return "unified";
  }
}

/** Current layout for new cards. */
export function getDiffLayout(): DiffLayout {
  return current;
}

/** Switch the global layout and notify open cards. */
export function setDiffLayout(layout: DiffLayout): void {
  if (layout === current) return;
  current = layout;
  try {
    localStorage.setItem(STORAGE_KEY, layout);
  } catch {
    // Persistence is best-effort; the choice still applies for this page.
  }
  for (const fn of listeners) fn();
}

/** Subscribe to layout changes; returns an unsubscribe function. */
export function onDiffLayoutChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
