// Resolving a page-supplied path against the pi working directory. The local
// read endpoints (directory listing, file preview) all go through it, so the
// containment rule and its error text live in one place: no relative escape,
// no absolute path, and no symlink that points outside after realpath.
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

/** A path resolved inside the cwd, or the reason it was refused. */
export type ScopedPath = { kind: "ok"; path: string } | { kind: "error"; error: string };

/** Resolve `path` (relative to `cwd`) and refuse anything leaving the cwd. */
export async function scopePath(cwd: string, path: string): Promise<ScopedPath> {
  const root = resolve(cwd);
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) return { kind: "error", error: "outside working directory" };
  try {
    const [realTarget, realRoot] = await Promise.all([realpath(target), realpath(root)]);
    const real = relative(realRoot, realTarget);
    if (real === "" || (!real.startsWith("..") && !isAbsolute(real))) return { kind: "ok", path: realTarget };
    return { kind: "error", error: "outside working directory" };
  } catch (error) {
    return { kind: "error", error: error instanceof Error ? error.message : String(error) };
  }
}