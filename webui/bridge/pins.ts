// Pinned sessions for the web UI sidebar: a small JSON store under
// ~/.pi/agent/webui. Session paths are stored verbatim; deleted sessions are
// pruned when the list is read so stale pins never surface.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const storePath = join(homedir(), ".pi", "agent", "webui", "pinned-sessions.json");

async function readPins(): Promise<string[]> {
  try {
    const raw = await readFile(storePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === "string");
  } catch {
    return [];
  }
}

async function writePins(paths: string[]): Promise<void> {
  await mkdir(dirname(storePath), { recursive: true });
  await writeFile(storePath, JSON.stringify(paths, null, 2), "utf8");
}

/** All pinned session paths, current order (insertion order). */
export async function listPins(): Promise<string[]> {
  return readPins();
}

/** Toggle one session's pin; returns the new state (true = pinned). */
export async function togglePin(path: string): Promise<boolean> {
  const pins = await readPins();
  const existing = pins.indexOf(path);
  if (existing >= 0) {
    pins.splice(existing, 1);
    await writePins(pins);
    return false;
  }
  pins.push(path);
  await writePins(pins);
  return true;
}

/** Remove a path from the pins if present (called after delete). */
export async function removePin(path: string): Promise<void> {
  const pins = await readPins();
  const existing = pins.indexOf(path);
  if (existing >= 0) {
    pins.splice(existing, 1);
    await writePins(pins);
  }
}
