// WebSocket JSONL client: correlate command ids with responses, fan out all
// records to listeners, auto-reconnect with backoff (PRD F-01/M4).
import type { ResponseRecord, WireRecord } from "./protocol";

export type Command = Record<string, unknown> & { type: string };

type Listener = (record: WireRecord) => void;

export type ConnState = "connecting" | "open" | "closed";

/** Default response deadline; a command that never answers must not hang the UI. */
const COMMAND_TIMEOUT_MS = 30_000;

/**
 * Commands that legitimately run for minutes (a bash command, a manual
 * compaction, a session switch that spawns pi). They get their own completion
 * signal (bash_execution_update / compaction_end / the attach response), so a
 * deadline would report failures for work that is still going.
 */
const LONG_RUNNING_COMMANDS = new Set([
  "bash",
  "compact",
  "clone",
  "fork",
  "switch_session",
  "new_session",
  "export_html",
  // Bridge-side commands that spawn pi, or wait on the user (native folder
  // dialog); their own completion is the signal.
  "bridge_attach",
  "bridge_new_session",
  "bridge_restart_pi",
  "bridge_pick_dir",
]);

type Pending = {
  command: string;
  resolve: (response: ResponseRecord) => void;
  timer: ReturnType<typeof setTimeout> | null;
};

export class RpcConnection {
  private ws: WebSocket | null = null;
  private nextId = 0;
  private pending = new Map<string, Pending>();
  private listeners = new Set<Listener>();
  private stateListeners = new Set<(state: ConnState) => void>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelayMs = 500;
  private closedByUser = false;
  private currentState: ConnState = "connecting";
  private readonly timeoutMs: number;

  /** `timeoutMs` exists for tests; the UI uses the default deadline. */
  constructor(options?: { timeoutMs?: number }) {
    this.timeoutMs = options?.timeoutMs ?? COMMAND_TIMEOUT_MS;
  }

  /** Latest connection state; lets late-mounting components skip the wait. */
  get state(): ConnState {
    return this.currentState;
  }

  connect(url: string): void {
    this.closedByUser = false;
    this.open(url);
  }

  private open(url: string): void {
    this.setState("connecting");
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.retryDelayMs = 500;
      this.setState("open");
    };
    ws.onmessage = (event) => {
      let record: WireRecord;
      try {
        record = JSON.parse(String(event.data)) as WireRecord;
      } catch {
        return;
      }
      if (record.type === "response") {
        const response = record as ResponseRecord;
        const id = typeof response.id === "string" ? response.id : undefined;
        const entry = id ? this.pending.get(id) : undefined;
        if (id && entry) {
          this.settle(id, entry, response);
        }
      } else if (record.type === "bridge_error") {
        // The bridge rejected a command it could not forward (no live pi).
        // Resolve it as a failed response so callers do not hang.
        const id = typeof record.for === "string" ? record.for : undefined;
        const entry = id ? this.pending.get(id) : undefined;
        if (id && entry) {
          this.settle(id, entry, {
            type: "response",
            command: entry.command,
            success: false,
            id,
            error: typeof record.error === "string" ? record.error : "bridge error",
          });
        }
      }
      for (const listener of this.listeners) listener(record);
    };
    ws.onclose = () => {
      this.ws = null;
      // Reject in-flight commands so callers never hang on a dead socket.
      for (const [id, entry] of [...this.pending]) {
        this.settle(id, entry, { type: "response", command: entry.command, success: false, error: "连接已断开" });
      }
      this.setState("closed");
      if (!this.closedByUser) this.scheduleReconnect(url);
    };
    ws.onerror = () => {
      // onclose follows; nothing else to do here.
    };
  }

  /** Resolve a pending command exactly once and stop its deadline. */
  private settle(id: string, entry: Pending, response: ResponseRecord): void {
    if (!this.pending.delete(id)) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve(response);
  }

  private scheduleReconnect(url: string): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryDelayMs = Math.min(this.retryDelayMs * 2, 8000);
      this.open(url);
    }, this.retryDelayMs);
  }

  close(): void {
    this.closedByUser = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  /**
   * Send a command; resolves with its correlated response. Never rejects: a
   * disconnected socket or a missed deadline resolves a failed response, so
   * every caller has one error path (`res.success === false`).
   *
   * A caller-supplied string id is kept: the `bash` command uses its id as
   * the correlation id of `bash_execution_update` events, so overwriting it
   * would make streamed output unmatchable (the response correlation still
   * works with the preserved id). All other callers rely on auto ids.
   */
  command(command: Command): Promise<ResponseRecord> {
    const id = typeof command.id === "string" && command.id ? command.id : `webui-${++this.nextId}`;
    const record = { ...command, id };
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        resolve({ type: "response", command: command.type, success: false, id, error: "连接已断开" });
        return;
      }
      const entry: Pending = { command: command.type, resolve, timer: null };
      if (!LONG_RUNNING_COMMANDS.has(command.type)) {
        entry.timer = setTimeout(() => {
          this.settle(id, entry, {
            type: "response",
            command: command.type,
            success: false,
            id,
            error: "命令超时，未收到 pi 的响应",
          });
        }, this.timeoutMs);
      }
      this.pending.set(id, entry);
      this.ws.send(JSON.stringify(record));
    });
  }

  /** Send a record verbatim: no id injection, no response tracking. Used
   * for extension_ui_response replies — they must keep the id of the
   * original extension_ui_request, and pi never echoes a response. */
  send(record: Command): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(record));
    return true;
  }

  onRecord(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onState(listener: (state: ConnState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private setState(state: ConnState): void {
    this.currentState = state;
    for (const listener of this.stateListeners) listener(state);
  }
}
