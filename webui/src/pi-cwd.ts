// Pi process working directory, reported from the pi_started lifecycle
// record in app.tsx. Module-level (same pattern as diff-layout.ts) so leaf
// components like the edit card can shorten arg paths without threading a
// prop through the whole message tree.
let current: string | null = null;
const listeners = new Set<() => void>();

/** Current pi cwd, or null before the first pi_started record. */
export function getPiCwd(): string | null {
  return current;
}

/** Update the pi cwd and notify subscribers. */
export function setPiCwd(cwd: string): void {
  if (current === cwd) return;
  current = cwd;
  for (const fn of listeners) fn();
}

/** Subscribe to cwd changes; returns an unsubscribe function. */
export function onPiCwdChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
