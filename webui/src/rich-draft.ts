// Helpers for the composer's rich draft: one contenteditable element that holds
// plain typing plus path chips. The element is uncontrolled DOM, so these read
// it back as message text and insert what typing cannot (chips, pasted text,
// injected editor text).
import { fileIconSvg } from "./file-icon";
import { splitPath } from "./path-label";
import type { Theme } from "./theme";

/** Message text of the draft: chips become code spans, block ends newlines. */
export function draftText(root: HTMLElement): string {
  let out = "";
  const walk = (parent: Node): void => {
    for (const child of parent.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        out += child.nodeValue ?? "";
        continue;
      }
      if (!(child instanceof HTMLElement)) continue;
      const path = child.dataset.path;
      if (path !== undefined) {
        out += `\`${path}\``;
        continue;
      }
      if (child.tagName === "BR") {
        out += "\n";
        continue;
      }
      // Chrome wraps each typed line in a div; the block's end is a newline.
      const block = child.tagName === "DIV" || child.tagName === "P";
      if (block && out !== "" && !out.endsWith("\n")) out += "\n";
      walk(child);
      if (block && !out.endsWith("\n")) out += "\n";
    }
  };
  walk(root);
  return out;
}

/** Replace the draft with plain text and put the caret at its end. */
export function setDraftText(root: HTMLElement, text: string): void {
  root.textContent = "";
  for (const node of textNodes(text)) root.appendChild(node);
  focusDraftEnd(root);
}

/** Empty the draft; the caller normally refocuses. */
export function clearDraft(root: HTMLElement): void {
  root.textContent = "";
}

/** Put the caret after the last node of the draft. */
export function focusDraftEnd(root: HTMLElement): void {
  root.focus();
  const selection = window.getSelection();
  if (selection === null) return;
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Insert a path chip at the caret, followed by a space to type on. */
export function insertDraftChip(root: HTMLElement, path: string, theme: Theme): void {
  const chip = document.createElement("span");
  chip.className = "path-chip";
  chip.contentEditable = "false";
  chip.dataset.path = path;
  chip.title = path;
  const icon = document.createElement("span");
  icon.className = "file-icon";
  icon.setAttribute("aria-hidden", "true");
  // The bundled icon bodies are trusted package assets, not user input.
  icon.innerHTML = fileIconSvg(path, theme);
  chip.appendChild(icon);
  chip.appendChild(document.createTextNode(splitPath(path).name));
  insertAtCaret(root, [chip, document.createTextNode(" ")]);
}

/** Paths of the draft's chips in order, so the sent bubble can mark them exactly. */
export function chipPaths(root: HTMLElement): string[] {
  const paths: string[] = [];
  for (const chip of root.querySelectorAll<HTMLElement>(".path-chip")) {
    const path = chip.dataset.path;
    if (path !== undefined) paths.push(path);
  }
  return paths;
}

/** Insert pasted text at the caret, one br per line and no markup. */
export function insertDraftText(root: HTMLElement, text: string): void {
  insertAtCaret(root, textNodes(text));
}

/** A path's text nodes; newlines become brs so the draft keeps its shape. */
function textNodes(text: string): Node[] {
  const nodes: Node[] = [];
  text.split("\n").forEach((line, index) => {
    if (index > 0) nodes.push(document.createElement("br"));
    if (line !== "") nodes.push(document.createTextNode(line));
  });
  return nodes;
}

/**
 * Insert nodes where the caret is, or at the end when the editor does not hold
 * the selection (a drop can arrive while the focus sits elsewhere).
 */
function insertAtCaret(root: HTMLElement, nodes: Node[]): void {
  root.focus();
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0 || selection.anchorNode === null || !root.contains(selection.anchorNode)) {
    for (const node of nodes) root.appendChild(node);
    focusDraftEnd(root);
    return;
  }
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const fragment = document.createDocumentFragment();
  for (const node of nodes) fragment.appendChild(node);
  const last = nodes.at(-1);
  range.insertNode(fragment);
  if (last === undefined) return;
  range.setStartAfter(last);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}