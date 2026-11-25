// Keybindings (M4, PRD P3 快捷键): configurable single place; Esc aborts a run.
// Enter/Shift+Enter handled in the composer textarea.

export type Keybindings = {
  abort: { key: string; label: string };
};

export const DEFAULT_KEYBINDINGS: Keybindings = {
  abort: { key: "Escape", label: "Esc" },
};

export function matchesKey(e: KeyboardEvent, binding: { key: string }): boolean {
  return e.key === binding.key;
}
