// Static file server for the built frontend (dist/) with content types.
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize, sep } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

function contentType(path: string): string {
  const ext = extname(path).toLowerCase();
  return (ext && MIME[ext]) || "application/octet-stream";
}

/** Resolve a URL path inside root, rejecting traversal outside it. */
function safeJoin(root: string, urlPath: string): string | null {
  const firstSegment = urlPath.split("?")[0] ?? "/";
  let decoded: string;
  try {
    decoded = decodeURIComponent(firstSegment);
  } catch {
    return null; // malformed percent-encoding
  }
  const resolved = normalize(join(root, decoded));
  if (resolved !== root && !resolved.startsWith(root + sep)) return null;
  return resolved;
}

export async function serveStatic(root: string, urlPath: string): Promise<{
  status: number;
  body?: Buffer;
  type?: string;
  /** Cache-Control for the response; hashed assets never change, the shell must revalidate. */
  cache?: string;
}> {
  const filePath = safeJoin(root, urlPath === "/" ? "/index.html" : urlPath);
  if (!filePath) return { status: 400 };

  let target = filePath;
  try {
    const s = await stat(target);
    if (s.isDirectory()) target = join(target, "index.html");
  } catch {
    // Not found: SPA fallback to index.html, but only for route-like paths
    // (no extension) so missing assets return 404 instead of HTML.
    if (extname(filePath) !== "") return { status: 404 };
    target = join(root, "index.html");
  }

  try {
    const body = await readFile(target);
    const cache = cacheControl(root, target);
    return { status: 200, body, type: contentType(target), ...(cache ? { cache } : {}) };
  } catch {
    return { status: 404 };
  }
}

/**
 * Vite writes hashed names under assets/, so those bytes never change and may be
 * cached forever. Everything else (index.html above all) must revalidate on every
 * reload: a rebuilt frontend has a new hash, and a cached shell would keep serving
 * the old one.
 */
function cacheControl(root: string, target: string): string | undefined {
  const rel = target.slice(root.length).split(sep).join("/");
  return rel.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
}
