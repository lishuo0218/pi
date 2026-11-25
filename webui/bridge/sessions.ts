// Session discovery for the web UI (F-20): scan pi's per-cwd session
// directory and summarize each file from its head. Mirrors pi's own
// directory encoding (packages/coding-agent/src/migrations.ts:112):
//   --${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--
import { open, readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";

export type SessionSummary = {
  path: string;
  name: string | null;
  preview: string | null;
  mtime: number;
};

export function sessionsDirFor(cwd: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(homedir(), ".pi", "agent", "sessions", safePath);
}

function previewOf(content: string): { name: string | null; preview: string | null } {
  let name: string | null = null;
  let preview: string | null = null;
  const lines = content.split("\n");
  for (const line of lines) {
    if (!line.startsWith("{")) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.type === "session_info" && typeof entry.name === "string") {
      name = entry.name;
    }
    if (!preview && entry.type === "message") {
      const message = entry.message as { role?: string; content?: unknown } | undefined;
      if (message?.role === "user") {
        const c = message.content;
        preview =
          typeof c === "string"
            ? c
            : Array.isArray(c)
              ? (c as { type?: string; text?: string }[])
                  .filter((b) => b.type === "text")
                  .map((b) => b.text ?? "")
                  .join(" ")
              : "";
        preview = preview.trim().slice(0, 80) || null;
      }
    }
    if (name && preview) break;
  }
  return { name, preview };
}

/** List at most `limit` sessions for cwd, newest first. */
export async function listSessions(cwd: string, limit = 20): Promise<SessionSummary[]> {
  return listSessionsIn(sessionsDirFor(cwd), limit);
}

/** List sessions in an explicit directory (custom --session-dir support). */
export async function listSessionsIn(dir: string, limit = 20): Promise<SessionSummary[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const summaries: SessionSummary[] = [];
  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    const path = join(dir, file);
    try {
      const info = await stat(path);
      // Read only the head of the file; sessions can be large.
      const handle = await open(path, "r");
      try {
        const headBuf = Buffer.alloc(64_000);
        const { bytesRead } = await handle.read(headBuf, 0, headBuf.length, 0);
        const { name, preview } = previewOf(headBuf.toString("utf8", 0, bytesRead));
        summaries.push({ path, name, preview, mtime: info.mtimeMs });
      } finally {
        await handle.close();
      }
    } catch {
      // Unreadable file: skip rather than fail the whole listing.
    }
  }
  summaries.sort((a, b) => b.mtime - a.mtime);
  return summaries.slice(0, limit);
}

export type SessionDirSummary = {
  /** Directory basename (encoded cwd, e.g. "--D--download-pi--"). */
  name: string;
  /** Real cwd from the newest session's header; null when unreadable. */
  cwd: string | null;
  /** Newest session file mtime, for ordering. */
  mtime: number;
};

export type SessionGroup = {
  /** Directory basename (encoded cwd). */
  name: string;
  /** Real cwd from the newest session's header; null when unreadable. */
  cwd: string | null;
  /** Newest session file mtime, for ordering. */
  mtime: number;
  sessions: SessionSummary[];
};

/**
 * Every session group under the sessions root, each with its recent
 * sessions; groups ordered by newest activity.
 */
export async function listAllSessions(root: string, limitPerDir = 20): Promise<SessionGroup[]> {
  const dirs = await listSessionDirs(root);
  const groups: SessionGroup[] = [];
  for (const dir of dirs) {
    const sessions = await listSessionsIn(join(root, dir.name), limitPerDir);
    groups.push({ name: dir.name, cwd: dir.cwd, mtime: dir.mtime, sessions });
  }
  return groups;
}

/**
 * Move a file to the Windows recycle bin via shell COM, so an accidental
 * delete stays recoverable; no npm dependency needed.
 */
export async function deleteToRecycleBin(path: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const escaped = path.replaceAll("'", "''");
    // Add-Type first: some PowerShell installs do not preload the assembly.
    const script = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${escaped}', 'OnlyErrorDialogs', 'SendToRecycleBin')`;
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], (error) => {
      if (error) reject(error);
      else resolvePromise();
    });
  });
}

/** Read the `cwd` field of a session file's first-line header. */
export async function headerCwd(path: string): Promise<string | null> {
  try {
    const handle = await open(path, "r");
    try {
      const buf = Buffer.alloc(4096);
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      const firstLine = buf.toString("utf8", 0, bytesRead).split("\n")[0] ?? "";
      const header = JSON.parse(firstLine) as { cwd?: unknown };
      return typeof header.cwd === "string" ? header.cwd : null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/**
 * Scan the sessions root for per-cwd group directories. The encoded dirname
 * is not reversible (/ \ : all map to "-"), so the real cwd is read from the
 * newest session file's header instead.
 */
export async function listSessionDirs(root: string): Promise<SessionDirSummary[]> {
  let dirents: Dirent[] = [];
  try {
    dirents = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const summaries: SessionDirSummary[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const dir = join(root, dirent.name);
    try {
      const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
      let newestPath: string | null = null;
      let newestMtime = 0;
      for (const file of files) {
        const path = join(dir, file);
        const info = await stat(path);
        if (info.mtimeMs > newestMtime) {
          newestMtime = info.mtimeMs;
          newestPath = path;
        }
      }
      if (!newestPath) continue;
      summaries.push({ name: dirent.name, cwd: await headerCwd(newestPath), mtime: newestMtime });
    } catch {
      // Unreadable directory: skip rather than fail the whole listing.
    }
  }
  summaries.sort((a, b) => b.mtime - a.mtime);
  return summaries;
}
