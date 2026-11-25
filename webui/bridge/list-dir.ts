// Directory listing for the side panel's file browser. One level per request,
// so a folder is read only when the page opens it (.git, node_modules). Paths
// are resolved against the pi working directory and may not leave it: the
// endpoint is token-gated like /api/edit-preview but browsing is scoped.
import { readdir } from "node:fs/promises";
import { scopePath } from "./cwd-path.ts";

export type ListDirEntry = { name: string; dir: boolean };
export type ListDirResponse = { entries: ListDirEntry[]; error?: string };

/** Sort: directories first, then natural name order so file2 precedes file10. */
function compare(a: ListDirEntry, b: ListDirEntry): number {
  if (a.dir !== b.dir) return a.dir ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}

/** Wire input from the page: `{ path }` relative to the cwd; absent means root. */
export async function handleListDir(body: unknown, cwd: string): Promise<ListDirResponse> {
  const req = body as { path?: unknown } | null;
  const path = req?.path ?? "";
  if (typeof path !== "string") return { entries: [], error: "invalid request: path must be a string" };

  const scoped = await scopePath(cwd, path);
  if (scoped.kind === "error") return { entries: [], error: scoped.error };

  try {
    const dirents = await readdir(scoped.path, { withFileTypes: true });
    const entries: ListDirEntry[] = dirents.map((d) => ({ name: d.name, dir: d.isDirectory() }));
    entries.sort(compare);
    return { entries };
  } catch (error) {
    return { entries: [], error: error instanceof Error ? error.message : String(error) };
  }
}