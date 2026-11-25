// File path label for tool cards: directory in tertiary colour, file name in
// primary. The directory collapses to a leading … when the bar overflows; the
// file name always stays visible.
import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";

/** Split a path into (dir, name) on either separator. */
export function splitPath(path: string): { dir: string; name: string } {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (index === -1) return { dir: "", name: path };
  return { dir: path.slice(0, index), name: path.slice(index + 1) };
}

/**
 * Path argument of a tool call. pi's tools name it `path`, but wire input from
 * extensions may use `file_path`/`filePath` for the same slot.
 */
export function toolPathArg(args: Record<string, unknown>): string | null {
  const raw = args.path ?? args.file_path ?? args.filePath;
  return typeof raw === "string" && raw !== "" ? raw : null;
}

/** Shorten an absolute path under cwd to cwd-relative; null otherwise. */
export function relativeToCwd(path: string, cwd: string | null): string | null {
  if (!cwd || !path) return null;
  if (!/^[a-zA-Z]:[\\/]/.test(path) && !path.startsWith("/") && !path.startsWith("\\")) return null;
  const fwd = (p: string): string => p.replaceAll("\\", "/");
  const pathFwd = fwd(path);
  const cwdFwd = fwd(cwd);
  const p = pathFwd.toLowerCase();
  const c = cwdFwd.toLowerCase();
  if (p === c || !p.startsWith(c + "/")) return null;
  // \u2192/ replacement is 1:1, so the normalized prefix length maps onto the original.
  return pathFwd.slice(cwdFwd.length + 1);
}

export function PathLabel({ dir, name, title }: { dir: string; name: string; title: string }): JSX.Element {
  const pathRef = useRef<HTMLSpanElement | null>(null);
  const [shown, setShown] = useState(dir);
  const shownRef = useRef(dir);
  const dirRef = useRef(dir); // RO closure spans renders; read the live prop
  /** Last measured box width; restore only when a later measure is wider. */
  const widthRef = useRef<number | null>(null);
  const shrink = (): void => {
    const el = pathRef.current;
    if (!el) return;
    const width = el.clientWidth;
    const grew = widthRef.current !== null && width > widthRef.current + 1;
    widthRef.current = width;
    if (el.scrollWidth <= width + 1) {
      // Fits: restore the full dir only if the box gained room. Restoring at
      // an unchanged width would overflow again and collapse in a loop, which
      // shows up as flicker in a narrow row.
      if (grew && shownRef.current !== dirRef.current) {
        shownRef.current = dirRef.current;
        setShown(dirRef.current);
      }
      return;
    }
    // Drop the leading … marker from the segment list so each step removes
    // one real directory, not the marker itself.
    const segments = shownRef.current.split(/[\\/]/).filter((s) => s !== "" && s !== "…");
    if (segments.length === 0) return; // … + name is minimal; CSS ellipsis clips further
    const rest = segments.slice(1).join("/");
    const next = rest !== "" ? "…/" + rest : "…";
    shownRef.current = next;
    setShown(next);
  };
  useEffect(() => {
    shownRef.current = dir;
    setShown(dir);
  }, [dir]);
  useEffect(shrink); // measure after every render; no-op while it fits
  useEffect(() => {
    const el = pathRef.current;
    if (!el) return;
    const ro = new ResizeObserver(shrink);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <span class="file-path" ref={pathRef} title={title}>
      {dir !== "" ? <span class="file-dir">{shown}/</span> : null}
      <span class="file-name">{name}</span>
    </span>
  );
}