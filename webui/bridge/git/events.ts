// Server-sent events for the Git view. The stream watches a repository's git
// directory and pushes a debounced `change` whenever HEAD, the index, a ref or
// an in-progress operation file moves. It carries no state: the page refetches
// status on each event, so a dropped connection only costs a refresh.
import { watch, type FSWatcher } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { resolveRepo, type Repo } from "./repo.ts";

/** A commit writes dozens of files; one burst is still one refresh. */
const DEBOUNCE_MS = 120;
/** Comment frames keep the connection alive through idle proxies. */
const HEARTBEAT_MS = 25_000;

/** Watch the git directory and everything that tracks refs and the index. */
function watchRepo(repo: Repo, onChange: () => void): FSWatcher[] {
  const watchers: FSWatcher[] = [];
  const follow = (path: string, recursive: boolean): void => {
    try {
      const watcher = watch(path, { persistent: false, recursive }, onChange);
      // A watched directory can disappear mid-operation (rebase-merge, logs);
      // its parent's events keep the stream alive, so a dead watcher is fine.
      watcher.on("error", () => watcher.close());
      watchers.push(watcher);
    } catch {
      // Absent directory: nothing to watch yet (no refs, no reflog, no rebase).
    }
  };
  follow(repo.gitDir, false);
  follow(join(repo.gitDir, "refs"), true);
  follow(join(repo.gitDir, "logs"), true);
  follow(join(repo.gitDir, "rebase-merge"), false);
  follow(join(repo.gitDir, "rebase-apply"), false);
  return watchers;
}

/** GET /api/git/events: `change` frames, or `unavailable` when there is no repo. */
export function handleGitEvents(_request: IncomingMessage, response: ServerResponse, cwd: string): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    // Ask proxies (Vite's dev proxy included) not to buffer the stream.
    "x-accel-buffering": "no",
  });
  let closed = false;
  const write = (text: string): void => {
    if (!closed) response.write(text);
  };
  const send = (event: string, data: unknown): void => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | null = null;
  const cleanup = (): void => {
    closed = true;
    if (timer !== null) clearTimeout(timer);
    clearInterval(heartbeat);
    for (const watcher of watchers) watcher.close();
  };
  const heartbeat = setInterval(() => write(": ping\n\n"), HEARTBEAT_MS);
  // EventSource reconnects on its own; this hint makes that retry fast.
  write("retry: 3000\n\n");
  response.on("close", cleanup);
  void resolveRepo(cwd).then((resolution) => {
    if (closed) return;
    if (resolution.kind === "error") {
      send("unavailable", { error: resolution.error, code: resolution.code });
      response.end();
      return;
    }
    const bump = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        send("change", { at: Date.now() });
      }, DEBOUNCE_MS);
    };
    watchers.push(...watchRepo(resolution.repo, bump));
    send("ready", { root: resolution.repo.root });
  });
}