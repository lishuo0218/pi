// File open in the preview column. Module-level (same pattern as pi-cwd.ts) so
// the file tree and the tool cards can open a preview without threading a
// callback through the message tree. Every open bumps `seq`, because reopening
// a path after closing it should read the file again.
export type PreviewRequest = { path: string; seq: number };

let current: PreviewRequest | null = null;
let seq = 0;
const listeners = new Set<() => void>();

/** The open preview request, or null when the column is closed. */
export function getPreviewRequest(): PreviewRequest | null {
  return current;
}

/** Open the preview column on `path` (cwd-relative or absolute). */
export function openPreview(path: string): void {
  seq += 1;
  current = { path, seq };
  for (const fn of listeners) fn();
}

/** Close the preview column. */
export function closePreview(): void {
  if (current === null) return;
  current = null;
  for (const fn of listeners) fn();
}

/** Subscribe to preview changes; returns an unsubscribe function. */
export function onPreviewChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}