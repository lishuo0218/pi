// Bridge server: HTTP static hosting + WebSocket JSONL pass-through to the
// pi runtime the browser is attached to. Bound to 127.0.0.1 by design (PRD:
// 安全). Each session gets its own pi runtime (see runtimes.ts), so switching
// sessions does not abort a run in another session.
// M4: auto-restart (with backoff), optional access token, single-active-tab
// takeover, export_html served over HTTP.
import http from "node:http";
import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { watch } from "node:fs";
import { dirname, basename, resolve as resolvePath } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { readPiVersion, type ProtocolRecord } from "./pi-process.ts";
import { RuntimePool, type Runtime } from "./runtimes.ts";
import { broadcast, wireClient, type LifecycleRecord } from "./ws-bridge.ts";
import { sessionsDirFor, listAllSessions, listSessionsIn, type SessionGroup } from "./sessions.ts";
import { serveStatic } from "./static-server.ts";
import { handleEditPreview, readJsonBody } from "./edit-preview.ts";
import { handleListDir } from "./list-dir.ts";

export type BridgeOptions = {
  port: number;
  host: string;
  piPath: string;
  cwd: string;
  staticRoot: string | null;
  piExtraArgs?: string[];
  /** Auto-restart the attached runtime after an abnormal exit (default true). */
  autoRestart?: boolean;
  /** Optional access token; when set, /ws requires ?token=<t>. */
  token?: string;
  /** Custom session directory (pi --session-dir); enables listing those sessions. */
  sessionDir?: string;
};

export type BridgeHandle = {
  port: number;
  piVersion: string;
  stop: () => void;
};

/** POST endpoints that read local files on behalf of the page (both cwd-scoped). */
const LOCAL_READS: Record<string, (body: unknown, cwd: string) => Promise<unknown>> = {
  "/api/edit-preview": handleEditPreview,
  "/api/list-dir": handleListDir,
};

function checkToken(request: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  const url = new URL(request.url ?? "/", "http://x");
  const given = Buffer.from(url.searchParams.get("token") ?? "");
  const expected = Buffer.from(token);
  // Constant-time compare: the token gates full agent access on this machine.
  return given.length === expected.length && given.equals(expected);
}

export function startBridge(opts: BridgeOptions): Promise<BridgeHandle> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = (req.url ?? "/").split("?")[0] ?? "/";
      const localRead = LOCAL_READS[url];
      if (localRead && req.method === "POST") {
        // Token-gated like /ws when a token is set: both endpoints read local
        // files on behalf of the page.
        if (!checkToken(req, opts.token)) {
          res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "forbidden" }));
          return;
        }
        readJsonBody(req, 1024 * 1024)
          .then((body) => localRead(body, pool.attached?.cwd ?? opts.cwd))
          .then(
            (result) => {
              res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
              res.end(JSON.stringify(result));
            },
            (error: unknown) => {
              res.writeHead(error instanceof Error && error.message === "body too large" ? 413 : 400, {
                "content-type": "application/json; charset=utf-8",
              });
              res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
            },
          );
        return;
      }
      const exportMatch = /^\/export\/([0-9a-f-]{8,64})$/i.exec(url);
      if (exportMatch) {
        const filePath = exportMatch[1] ? servedExports.get(exportMatch[1]) : undefined;
        if (!filePath) {
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          res.end("export not found (expired or unknown)");
          return;
        }
        readFile(filePath)
          .then((body) => {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(body);
          })
          .catch(() => {
            res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
            res.end("export file unreadable");
          });
        return;
      }
      if (!opts.staticRoot) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("static root not configured (run npm run build first)");
        return;
      }
      serveStatic(opts.staticRoot, url).then(
        ({ status, body, type, cache }) => {
          const headers: Record<string, string> = {};
          if (type) headers["content-type"] = type;
          if (cache) headers["cache-control"] = cache;
          res.writeHead(status, headers);
          res.end(body ?? "");
        },
        (error: unknown) => {
          res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          res.end(String(error));
        },
      );
    });

    const wss = new WebSocketServer({
      server,
      path: "/ws",
      // Token check at the trust boundary: WS upgrade carries ?token=.
      verifyClient: (info, cb) => cb(checkToken(info.req, opts.token)),
    });

    let lastExitCode: number | null = null;
    let lastExitSignal: string | null = null;
    let stopping = false;
    /** Initial runtime still starting: report it as started, not as exited. */
    let booting = true;
    let piVersion = "";
    const autoRestart = opts.autoRestart ?? true;

    /** Sessions root: --session-dir when given, else pi's per-cwd parent dir. */
    const sessionsRoot = (): string => {
      const cwd = pool.attached?.cwd ?? opts.cwd;
      return opts.sessionDir ?? dirname(sessionsDirFor(cwd));
    };

    /**
     * Sidebar session groups. pi writes sessions flat into a custom
     * --session-dir (no per-cwd subdirectory), so that case is one group.
     */
    const listGroups = async (): Promise<(SessionGroup & { current: boolean })[]> => {
      const cwd = pool.attached?.cwd ?? opts.cwd;
      if (opts.sessionDir) {
        const root = opts.sessionDir;
        return [
          {
            name: basename(root) || root,
            cwd,
            mtime: 0,
            sessions: await listSessionsIn(root),
            current: true,
          },
        ];
      }
      const groups = await listAllSessions(dirname(sessionsDirFor(cwd)));
      return groups.map((g) => ({ ...g, current: g.cwd === cwd }));
    };

    const currentLifecycle = (): LifecycleRecord => {
      const runtime = pool.attached;
      const alive = runtime !== null || booting;
      return {
        type: alive ? "pi_started" : "pi_exited",
        ...(alive ? {} : { code: lastExitCode, signal: lastExitSignal }),
        // Protocol-match hint for the frontend (PRD: 协议回退); empty when the
        // version probe failed.
        piVersion,
        // Working directory of the attached runtime; the UI defaults its
        // new-session dialog to it.
        cwd: runtime?.cwd ?? opts.cwd,
        ...(runtime?.sessionPath ? { sessionPath: runtime.sessionPath } : {}),
      };
    };

    // export_html interception: pi writes the HTML file locally; the bridge
    // serves it over HTTP so the browser can open it in a new tab.
    const exportWaiters = new Map<string, (response: ProtocolRecord) => void>();
    const servedExports = new Map<string, string>();

    /** Live runtimes with their run state, for the sidebar run badges. */
    const broadcastRuntimes = (): void => {
      broadcast(wss, { type: "bridge_notice", notice: "runtimes", runtimes: pool.list() });
    };

    const onRecord = (runtime: Runtime, record: ProtocolRecord) => {
      // Background runtimes keep being read (pi applies stdout backpressure)
      // but their records belong to a session the browser is not showing; it
      // rebuilds from get_state/get_messages when it attaches again.
      if (runtime !== pool.attached) return;
      const id = record.id;
      if (typeof id === "string") {
        const waiter = exportWaiters.get(id);
        if (waiter) {
          exportWaiters.delete(id);
          waiter(record);
        }
      }
      broadcast(wss, record);
    };

    let restartAttempts = 0;
    let attachedSince = 0;

    const pool = new RuntimePool({
      piPath: opts.piPath,
      cwd: opts.cwd,
      extraArgs: opts.piExtraArgs,
      onRecord,
      onChange: broadcastRuntimes,
      onExit: (runtime, wasAttached, code, signal) => {
        lastExitCode = code;
        lastExitSignal = signal;
        if (!wasAttached) {
          // A background runtime died: its run is gone, but the session file
          // is intact and attaching again starts a fresh process. No restart
          // loop for a session nobody is looking at.
          return;
        }
        broadcast(wss, { type: "pi_exited", code, signal });
        // Auto-restart after an abnormal exit unless the bridge is shutting
        // down (PRD M4: 崩溃自动重启). A code of 0 on orderly stdin close is
        // also restarted: pi exits 0 when killed via taskkill too, and the UI
        // treats a dead pi the same either way. A stable run (>60s) resets the
        // backoff; rapid crash loops escalate to at most 30s instead of
        // hammering a broken pi path once a second.
        if (autoRestart && !stopping) {
          if (attachedSince > 0 && Date.now() - attachedSince > 60_000) restartAttempts = 0;
          restartAttempts++;
          const delay = Math.min(1000 * 2 ** (restartAttempts - 1), 30_000);
          setTimeout(() => {
            if (stopping) return;
            void pool.reopen().then(
              () => {
                attachedSince = Date.now();
                broadcast(wss, currentLifecycle());
              },
              (error: unknown) => {
                broadcast(wss, {
                  type: "pi_error",
                  message: error instanceof Error ? error.message : String(error),
                });
              },
            );
          }, delay);
        }
      },
      onError: (runtime, error) => {
        if (runtime !== pool.attached) return;
        broadcast(wss, { type: "pi_error", message: error.message });
      },
    });

    const respond = (ws: WebSocket, payload: ProtocolRecord): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
    };

    // pi writes the session file lazily (on first message, not at session
    // creation), so the sidebar list would miss a brand-new empty session.
    // Watch the sessions root and nudge clients to reload their list when
    // anything on disk changes; also covers sessions created by other pi
    // instances. Debounced: a chat turn touches the file several times.
    // The root itself does not depend on the attached runtime (it is pi's
    // sessions directory, or the custom --session-dir).
    const watchRoot = resolvePath(sessionsRoot());
    let dirtyTimer: ReturnType<typeof setTimeout> | null = null;
    const sessionsWatcher = watch(watchRoot, { recursive: true }, () => {
      if (dirtyTimer) return;
      dirtyTimer = setTimeout(() => {
        dirtyTimer = null;
        broadcast(wss, { type: "bridge_notice", notice: "sessions_dirty" });
      }, 500);
    });
    sessionsWatcher.on("error", () => {
      // Best-effort only (e.g. root missing); listing still works on demand.
      sessionsWatcher.close();
    });

    /** Forward export_html to pi, then serve the written file at /export/<id>. */
    const handleExport = (requestId: unknown, ws: WebSocket): void => {
      const exportId = randomUUID();
      exportWaiters.set(exportId, (record) => {
        const resp = record as { success?: boolean; data?: { path?: string }; error?: string };
        if (!resp.success || typeof resp.data?.path !== "string") {
          respond(ws, {
            type: "response",
            command: "export_html",
            success: false,
            id: requestId ?? null,
            error: resp.error ?? "export failed",
          });
          return;
        }
        servedExports.set(exportId, resp.data.path);
        while (servedExports.size > 5) {
          const first = servedExports.keys().next().value;
          if (first === undefined) break;
          servedExports.delete(first);
        }
        respond(ws, {
          type: "response",
          command: "export_html",
          success: true,
          id: requestId ?? null,
          data: { url: `/export/${exportId}` },
        });
      });
      if (!pool.send({ type: "export_html", id: exportId })) {
        exportWaiters.delete(exportId);
        respond(ws, {
          type: "response",
          command: "export_html",
          success: false,
          id: requestId ?? null,
          error: "pi process is not running",
        });
      }
    };

    // Single-active-tab takeover (PRD M4 decision): the newest WS forwards
    // commands; older tabs are downgraded to read-only spectators. When the
    // active tab closes, control returns to the oldest remaining tab.
    let activeWs: WebSocket | null = null;
    const clients = new Set<WebSocket>();

    const restartPi = (): void => {
      broadcast(wss, { type: "bridge_notice", notice: "pi_restarting" });
      void pool.restart().then(
        () => {
          attachedSince = Date.now();
          broadcast(wss, currentLifecycle());
        },
        (error: unknown) => {
          broadcast(wss, {
            type: "pi_error",
            message: error instanceof Error ? error.message : String(error),
          });
        },
      );
    };

    wss.on("connection", (ws) => {
      clients.add(ws);
      if (activeWs && activeWs.readyState === WebSocket.OPEN) {
        activeWs.send(JSON.stringify({ type: "bridge_notice", notice: "taken_over" }));
      }
      activeWs = ws;
      wireClient(ws, {
        send: (record) => pool.send(record),
        lifecycle: currentLifecycle,
        // Evaluated per command: cwd changes when another session is attached.
        sessionsRoot,
        listGroups,
        attach: (sessionPath) =>
          pool.attach(sessionPath).then((runtime) => {
            // The attached runtime's cwd changed: refresh the lifecycle record
            // so the UI's new-session dialog follows it.
            broadcast(wss, currentLifecycle());
            return { sessionPath: runtime.sessionPath };
          }),
        newSession: (cwd) =>
          pool.create(cwd ?? pool.attached?.cwd ?? opts.cwd).then((runtime) => {
            broadcast(wss, currentLifecycle());
            return { cwd: runtime.cwd };
          }),
        stopSession: (sessionPath) =>
          pool.stopSession(sessionPath).then(() => {
            broadcast(wss, currentLifecycle());
          }),
        pendingRecords: () => pool.pendingRecords(),
        isActive: () => ws === activeWs,
        restartPi,
        handleExport,
      });
      ws.on("close", () => {
        clients.delete(ws);
        if (ws !== activeWs) return;
        activeWs = null;
        for (const client of clients) {
          if (client.readyState === WebSocket.OPEN) {
            activeWs = client;
            client.send(JSON.stringify({ type: "bridge_notice", notice: "active" }));
            break;
          }
        }
      });
    });

    server.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        reject(new Error(`端口 ${opts.port} 已被占用。用 --port 指定其他端口。`));
      } else {
        reject(error);
      }
    });

    server.listen(opts.port, opts.host, () => {
      readPiVersion(opts.piPath).then((version) => {
        piVersion = version;
        resolve({
          port: opts.port,
          piVersion,
          stop: () => {
            stopping = true;
            pool.stopAll();
            sessionsWatcher.close();
            wss.close();
            server.close();
          },
        });
      });
      pool.start().then(
        () => {
          booting = false;
          attachedSince = Date.now();
          broadcast(wss, currentLifecycle());
        },
        (error: unknown) => {
          booting = false;
          // No live runtime: tell the UI (it offers a restart) and then why.
          broadcast(wss, currentLifecycle());
          broadcast(wss, {
            type: "pi_error",
            message: error instanceof Error ? error.message : String(error),
          });
        },
      );
    });
  });
}