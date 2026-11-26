// Drag payload shared by the file tree and the composer: a tree row hands over
// the row's absolute path, which a drop turns into a draft chip, and the page
// refuses that drag everywhere except the composer.
export const PATH_DRAG_TYPE = "application/x-pi-path";

/** Absolute path of one tree row; tree paths are relative to the pi cwd. */
export function pathDragPath(cwd: string, relPath: string): string {
  const sep = cwd.includes("\\") ? "\\" : "/";
  const base = cwd.replace(/[\\/]+$/, "");
  return relPath === "" ? base : `${base}${sep}${relPath.split("/").join(sep)}`;
}

/** A path as it reads inside a message: a one-line code span. */
export function codeSpan(path: string): string {
  return `\`${path}\``;
}

/** True when a drag carries a tree path; only the composer takes those. */
export function carriesPath(data: DataTransfer | null): data is DataTransfer {
  return data !== null && data.types.includes(PATH_DRAG_TYPE);
}

/** Payload for a tree-row drag: the raw path, plus its code span as plain text. */
export function startPathDrag(e: DragEvent, path: string): void {
  const data = e.dataTransfer;
  if (data === null) return;
  data.setData(PATH_DRAG_TYPE, path);
  // Plain text as well: dropped outside the app, the path is still usable.
  data.setData("text/plain", codeSpan(path));
  data.effectAllowed = "copy";
}

/**
 * Refuse path drops outside the composer. The drag carries text/plain, which the
 * browser accepts anywhere, so without this the whole window looks droppable.
 * A handler that takes the drop calls preventDefault first, and that is skipped
 * here, so the composer keeps its own cursor and highlight.
 */
export function installPathDropGuard(): void {
  window.addEventListener("dragover", (e) => {
    const data = e.dataTransfer;
    if (e.defaultPrevented || !carriesPath(data)) return;
    e.preventDefault();
    data.dropEffect = "none";
  });
  window.addEventListener("drop", (e) => {
    if (e.defaultPrevented || !carriesPath(e.dataTransfer)) return;
    e.preventDefault();
  });
}