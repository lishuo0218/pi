// WebSocket JSONL client: correlate command ids with responses, fan out all
// records to listeners, auto-reconnect with backoff (PRD F-01/M4).
import type { ResponseRecord, WireRecord } from "./protocol";

export type Command = Record<string, unknown> & { type: string };

type Listener = (record: WireRecord) => void;

export type ConnState = "connecting" | "open" | "closed";

export class RpcConnection {
  private ws: WebSocket | null = null;
  private nextId = 0;
  private pending = new Map<string, { command: string; resolve: (r: ResponseRecord) => void }>();
  private listeners = new Set<Listener>();
  private stateListeners = new Set<(state: ConnState) => void>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelayMs = 500;
  private closedByUser = false;
  private currentState: ConnState = "connecting";

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
        if (id) {
          const entry = this.pending.get(id);
          if (entry) {
            this.pending.delete(id);
            entry.resolve(response);
          }
        }
      } else if (record.type === "bridge_error") {
        // The bridge rejected a command it could not forward (no live pi).
        // Resolve it as a failed response so callers do not hang.
        const id = typeof record.for === "string" ? record.for : undefined;
        const entry = id ? this.pending.get(id) : undefined;
        if (id && entry) {
          this.pending.delete(id);
          entry.resolve({
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
      for (const entry of this.pending.values()) {
        entry.resolve({ type: "response", command: entry.command, success: false, error: "连接已断开" });
      }
      this.pending.clear();
      this.setState("closed");
      if (!this.closedByUser) this.scheduleReconnect(url);
    };
    ws.onerror = () => {
      // onclose follows; nothing else to do here.
    };
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
   * Send a command; resolves with its correlated response.
   * A caller-supplied string id is kept: the `bash` command uses its id as
   * the correlation id of `bash_execution_update` events, so overwriting it
   * would make streamed output unmatchable (the response correlation still
   * works with the preserved id). All other callers rely on auto ids.
   */
  command(command: Command): Promise<ResponseRecord> {
    const id = typeof command.id === "string" && command.id ? command.id : `webui-${++this.nextId}`;
    const record = { ...command, id };
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("not connected"));
        return;
      }
      this.pending.set(id, { command: command.type, resolve });
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
