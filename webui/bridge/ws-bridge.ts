// WebSocket bridge: pass protocol records between the browser and the pi
// runtime it is attached to, without parsing or rewriting them (except bridge
// lifecycle records and bridge_* commands handled locally). Slow WS consumers
// buffer; the pi side is always drained.
import type { WebSocketServer, WebSocket } from "ws";
import { resolve, sep } from "node:path";
import type { ProtocolRecord } from "./pi-process.ts";
import { deleteToRecycleBin, type SessionGroup } from "./sessions.ts";
import { listPins, removePin, togglePin } from "./pins.ts";
import { pickDirectory } from "./pick-dir.ts";

export type LifecycleType = "pi_started" | "pi_exited" | "pi_error";

export type LifecycleRecord = ProtocolRecord & {
  type: LifecycleType;
  code?: number | null;
  signal?: string | null;
  message?: string;
  /** pi --version probe result; empty when unknown (protocol-match hint). */
  piVersion?: string;
  /** Attached runtime's working directory (resolved). */
  cwd?: string;
  /** Attached runtime's session file; absent for an unsaved session. */
  sessionPath?: string;
};

/** Records the browser may never see: nothing yet, but keep the seam. */
export function toClientRecord(record: ProtocolRecord): ProtocolRecord {
  return record;
}

export function broadcast(wss: WebSocketServer, record: ProtocolRecord): void {
  const payload = JSON.stringify(record);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) {
      // Buffering send: slow consumers accumulate in the socket buffer. We
      // deliberately never drop records: finalizing records (message_end,
      // tool_execution_end) are required for correct state (PRD: 背压).
      client.send(payload);
    }
  }
}

/** True if the record is a command needing a response (has a type, not an event dump). */
export function isCommand(record: ProtocolRecord): boolean {
  return typeof record.type === "string" && record.type.length > 0;
}

/** What a browser connection can reach in the bridge (owned by server.ts). */
export type ClientContext = {
  /** Send a record to the attached pi runtime; false when none is live. */
  send: (record: ProtocolRecord) => boolean;
  /** Lifecycle of the attached runtime (sent on connect). */
  lifecycle: () => LifecycleRecord;
  /** Root holding every listable session (custom --session-dir aware). */
  sessionsRoot: () => string;
  /** Session groups for the sidebar, `current` marked for the attached runtime. */
  listGroups: () => Promise<(SessionGroup & { current: boolean })[]>;
  /** Attach to a session, starting its runtime when it is not live. */
  attach: (sessionPath: string) => Promise<{ sessionPath: string | null }>;
  /** Start a fresh session runtime in cwd (null = keep the current directory). */
  newSession: (cwd: string | null) => Promise<{ cwd: string | null }>;
  /** Stop the runtime holding a session file so the file is free to delete. */
  stopSession: (sessionPath: string) => Promise<void>;
  /** Records of the attached runtime's in-flight assistant message. */
  pendingRecords: () => ProtocolRecord[];
  isActive: () => boolean;
  restartPi: () => void;
  handleExport: (requestId: unknown, ws: WebSocket) => void;
};

type Reply = {
  command: string;
  id: unknown;
  success: boolean;
  data?: unknown;
  error?: string;
};

export function wireClient(ws: WebSocket, ctx: ClientContext): void {
  const reply = (r: Reply): void => {
    if (ws.readyState !== ws.OPEN) return;
    const record: ProtocolRecord = {
      type: "response",
      command: r.command,
      success: r.success,
      id: r.id ?? null,
      ...(r.success ? { data: r.data ?? null } : { error: r.error }),
    };
    ws.send(JSON.stringify(record));
  };
  /** Run a promise-returning bridge action and reply with its data or error. */
  const replyFrom = (command: string, id: unknown, action: () => Promise<unknown>): void => {
    action().then(
      (data) => reply({ command, id, success: true, data }),
      (error: unknown) =>
        reply({
          command,
          id,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
  };

  ws.send(JSON.stringify(ctx.lifecycle()));
  ws.on("message", (data) => {
    let record: ProtocolRecord;
    try {
      record = JSON.parse(data.toString()) as ProtocolRecord;
    } catch {
      ws.send(JSON.stringify({ type: "bridge_error", error: "unparseable JSON from browser" }));
      return;
    }
    if (!isCommand(record)) return;
    // Read-only spectators (a newer tab took over) cannot send commands.
    if (!ctx.isActive()) {
      ws.send(
        JSON.stringify({ type: "bridge_notice", notice: "read_only", for: record.id ?? null }),
      );
      return;
    }
    switch (record.type) {
      // All session groups (per working directory) with their recent
      // sessions; the frontend renders one collapsible section per group.
      case "bridge_list_all_sessions": {
        Promise.all([ctx.listGroups(), listPins()]).then(
          ([groups, pins]) => {
            reply({
              command: "bridge_list_all_sessions",
              id: record.id,
              success: true,
              data: {
                groups: groups.map((g) => ({
                  ...g,
                  sessions: g.sessions.map((s) => ({ ...s, pinned: pins.includes(s.path) })),
                })),
              },
            });
          },
          (error: unknown) =>
            reply({ command: "bridge_list_all_sessions", id: record.id, success: false, error: String(error) }),
        );
        return;
      }
      case "bridge_attach": {
        // Switching sessions attaches to that session's runtime instead of
        // replacing the session of a shared pi process: runs in other
        // sessions keep going in the background.
        const sessionPath = typeof record.sessionPath === "string" ? record.sessionPath : "";
        if (!sessionPath) {
          reply({ command: "bridge_attach", id: record.id, success: false, error: "会话路径不能为空" });
          return;
        }
        replyFrom("bridge_attach", record.id, () => ctx.attach(sessionPath));
        return;
      }
      case "bridge_new_session": {
        // A new session gets its own runtime, so nothing running is aborted.
        const cwd = typeof record.cwd === "string" && record.cwd.trim() ? record.cwd.trim() : null;
        replyFrom("bridge_new_session", record.id, () => ctx.newSession(cwd));
        return;
      }
      case "bridge_toggle_pin": {
        const root = resolve(ctx.sessionsRoot());
        const target = typeof record.path === "string" ? resolve(record.path) : "";
        const allowed = target.endsWith(".jsonl") && target.startsWith(root + sep);
        if (!allowed) {
          reply({ command: "bridge_toggle_pin", id: record.id, success: false, error: "路径不在会话目录内" });
          return;
        }
        replyFrom("bridge_toggle_pin", record.id, async () => ({ pinned: await togglePin(target) }));
        return;
      }
      case "bridge_pick_dir": {
        // Show the native folder dialog; resolves null on cancel.
        replyFrom("bridge_pick_dir", record.id, async () => ({ path: await pickDirectory() }));
        return;
      }
      case "bridge_delete_session": {
        // Trust boundary: browser input. Only .jsonl files inside the sessions
        // root are deletable, and they go to the recycle bin. The runtime
        // holding the file is stopped first: Windows cannot delete an open
        // file, and a deleted session cannot keep running.
        const root = resolve(ctx.sessionsRoot());
        const target = typeof record.path === "string" ? resolve(record.path) : "";
        const allowed = target.endsWith(".jsonl") && target.startsWith(root + sep);
        if (!allowed) {
          reply({ command: "bridge_delete_session", id: record.id, success: false, error: "路径不在会话目录内" });
          return;
        }
        replyFrom("bridge_delete_session", record.id, async () => {
          await ctx.stopSession(target);
          await deleteToRecycleBin(target);
          // A deleted session can no longer be pinned.
          await removePin(target);
          return null;
        });
        return;
      }
      case "bridge_resume": {
        // The client just hydrated from get_messages, which has no partial
        // message: replay the records of the turn still streaming so the
        // text produced before it attached is rendered too. Sent before the
        // response, so the client applies them and then continues live.
        for (const pending of ctx.pendingRecords()) ws.send(JSON.stringify(pending));
        reply({ command: "bridge_resume", id: record.id, success: true, data: null });
        return;
      }
      case "bridge_restart_pi": {
        ctx.restartPi();
        reply({ command: "bridge_restart_pi", id: record.id, success: true });
        return;
      }
      case "export_html": {
        // Intercepted: the bridge forwards it to pi, then serves the written
        // file so the browser can open it (see server.ts handleExport).
        ctx.handleExport(record.id, ws);
        return;
      }
      default: {
        if (!ctx.send(toClientRecord(record))) {
          ws.send(
            JSON.stringify({
              type: "bridge_error",
              error: "pi process is not running",
              for: record.id ?? null,
            }),
          );
        }
      }
    }
  });
}