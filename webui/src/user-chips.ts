// Chips in a sent user message. The composer turns a dropped path into a chip
// and serializes it as a code span, so a bubble has to turn those spans back
// into chips: prompts sent from this tab remember their exact chip paths, older
// history falls back to the shape of the span (an absolute path).
export type UserPart = { kind: "text"; text: string } | { kind: "chip"; path: string };

/** Chip paths per prompt sent from this tab, keyed by the message text. */
const sentChips = new Map<string, readonly string[]>();
/** Only the last few prompts keep exact chips; older bubbles use the heuristic. */
const KEPT_PROMPTS = 20;

/** Record which spans of a prompt were chips, for the bubble that follows it. */
export function rememberSentChips(text: string, paths: readonly string[]): void {
  if (paths.length === 0) return;
  sentChips.set(text, paths);
  const oldest = sentChips.keys().next().value;
  if (sentChips.size > KEPT_PROMPTS && oldest !== undefined) sentChips.delete(oldest);
}

/** Inline code spans, the form the composer writes a chip in. */
const CODE_SPAN = /`([^`\n]+)`/g;
/** Absolute path: Windows drive letter or POSIX root. */
const ABSOLUTE_PATH = /^(?:[a-zA-Z]:[\\/]|\/)/;

/** Split message text into plain runs and path chips, in order. */
export function userParts(text: string): UserPart[] {
  const exact = sentChips.get(text);
  const parts: UserPart[] = [];
  let at = 0;
  for (const match of text.matchAll(CODE_SPAN)) {
    // The span without its backticks.
    const path = match[0].slice(1, -1);
    const isChip = exact === undefined ? ABSOLUTE_PATH.test(path) : exact.includes(path);
    if (!isChip) continue;
    const start = match.index ?? 0;
    if (start > at) parts.push({ kind: "text", text: text.slice(at, start) });
    parts.push({ kind: "chip", path });
    at = start + match[0].length;
  }
  if (at < text.length) parts.push({ kind: "text", text: text.slice(at) });
  return parts;
}

/**
 * Copying a chip must give back the `path` code span the composer sent, not the
 * file name the bubble draws. Runs on every copy: only a selection that holds a
 * chip is rewritten.
 */
export function installChipCopy(): void {
  document.addEventListener("copy", (event) => {
    const selection = document.getSelection();
    if (selection === null || selection.rangeCount === 0) return;
    const fragment = selection.getRangeAt(0).cloneContents();
    const chips = [...fragment.querySelectorAll<HTMLElement>(".path-chip[data-path]")];
    if (chips.length === 0) return;
    const data = event.clipboardData;
    if (data === null) return;
    for (const chip of chips) chip.replaceWith(`\`${chip.dataset.path}\``);
    data.setData("text/plain", fragment.textContent ?? "");
    event.preventDefault();
  });
}