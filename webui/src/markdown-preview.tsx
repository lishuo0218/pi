// Rendered markdown body of the file preview. Images with local paths are read
// through /api/file-preview and inlined as data URLs, so a relative path like
// ./img/a.png shows the file next to the markdown file. Local links replace the
// preview; every other link opens in a new tab.
import { useEffect, useRef } from "preact/hooks";
import type { JSX } from "preact";
import { joinPath, splitPath } from "./path-label";

/** Absolute path of a local link target, or null when the href is remote. */
function resolveHref(baseFile: string, href: string): string | null {
  if (href === "" || href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return null;
  const cut = href.search(/[?#]/);
  const raw = cut === -1 ? href : href.slice(0, cut);
  let rel = raw;
  try {
    rel = decodeURIComponent(raw);
  } catch {
    // A malformed escape stays as written and simply fails to resolve.
  }
  return joinPath(splitPath(baseFile).dir, rel);
}

/** Local images already inlined, keyed by path: toggling views must not refetch. */
const imageCache = new Map<string, string>();
const IMAGE_CACHE_LIMIT = 40;

/** data URL for a local image, or null when it is not a readable image. */
async function readImage(path: string): Promise<string | null> {
  const hit = imageCache.get(path);
  if (hit !== undefined) return hit;
  try {
    const res = await fetch("/api/file-preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    });
    if (!res.ok) return null;
    // Wire input, so the shape is checked before it becomes an image source.
    const data = (await res.json()) as Record<string, unknown> | null;
    if (data?.kind !== "image" || typeof data.mimeType !== "string" || typeof data.data !== "string") return null;
    const url = `data:${data.mimeType};base64,${data.data}`;
    if (imageCache.size >= IMAGE_CACHE_LIMIT) {
      const first = imageCache.keys().next().value;
      if (first !== undefined) imageCache.delete(first);
    }
    imageCache.set(path, url);
    return url;
  } catch {
    return null;
  }
}

export function MarkdownPreview({ html, path, onOpenFile }: {
  /** Sanitized HTML from renderMarkdownFile. */
  html: string;
  /** Markdown file the html came from: base for relative images and links. */
  path: string;
  /** Opens a local link target in place of this file. */
  onOpenFile: (path: string) => void;
}): JSX.Element {
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const body = bodyRef.current;
    if (body === null) return;
    let live = true;
    for (const img of body.querySelectorAll<HTMLImageElement>("img[src]")) {
      const source = img.getAttribute("src") ?? "";
      const target = resolveHref(path, source);
      if (target === null) continue;
      // Drop the raw src first: the browser would otherwise request the path
      // from the dev server and flash a broken image while it loads.
      img.removeAttribute("src");
      void readImage(target).then((url) => {
        if (!live) return;
        if (url === null) img.classList.add("md-img-missing");
        else img.src = url;
      });
    }
    return () => {
      live = false;
    };
  }, [html, path]);

  const onClick = (event: JSX.TargetedMouseEvent<HTMLDivElement>): void => {
    const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (anchor === null) return;
    event.preventDefault();
    const href = anchor.getAttribute("href") ?? "";
    const target = resolveHref(path, href);
    if (target !== null) onOpenFile(target);
    else if (href !== "" && !href.startsWith("#")) window.open(href, "_blank", "noopener");
  };

  return <div class="md-body" ref={bodyRef} dangerouslySetInnerHTML={{ __html: html }} onClick={onClick} />;
}