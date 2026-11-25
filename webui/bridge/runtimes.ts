// Runtime pool: one pi --mode rpc child per live session. The browser is
// attached to one runtime at a time; the others keep running in the
// background, so switching sessions no longer aborts the run being left.
// Background runtimes are stopped once they have been idle for a while, so
// the process count stays bounded.
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { PiProcess, type ProtocolRecord } from "./pi-process.ts";
import { headerCwd } from "./sessions.ts";

/** One live pi process bound to one session (or to an unsaved new session). */
export type Runtime = {
  /** Resolved session file; null until a fresh session is written to disk. */
  sessionPath: string | null;
  pi: PiProcess;
  /** pi working directory: the session's own cwd for a resumed session. */
  cwd: string;
  /** True between agent_start and agent_settled. */
  running: boolean;
  /** Last record seen; idle pruning ages background runtimes by this. */
  lastActive: number;
  /** In-flight get_state probe: spawn readiness, or a session-file refresh. */
  probe: { id: string; settle: (ok: boolean) => void } | null;
  /** Id of a get_state sent only to learn the session file. */
  stateProbeId: string | null;
  /**
   * Records of the assistant message being streamed right now (message_start
   * plus its message_update deltas), or null between messages. Replayed to a
   * client that attaches mid-turn: get_messages only has finished messages.
   */
  stream: ProtocolRecord[] | null;
  /**
   * Details of the last todo tool result, replayed to a client that attaches
   * later: the checklist must survive a reload even when compaction has dropped
   * the tool result from get_messages. Cleared when the session is replaced.
   */
  todoDetails: unknown;
};

export type RuntimePoolOptions = {
  piPath: string;
  /** Working directory of the initial runtime and of every fresh session. */
  cwd: string;
  /** Extra CLI args for every runtime (--no-session, --session-dir, ...). */
  extraArgs?: string[];
  /** Background runtimes idle for longer than this are stopped. */
  idleTtlMs?: number;
  /** Every record of every runtime (the server forwards the attached one). */
  onRecord: (runtime: Runtime, record: ProtocolRecord) => void;
  onExit: (
    runtime: Runtime,
    /** The exited runtime was the one the browser was attached to. */
    wasAttached: boolean,
    code: number | null,
    signal: NodeJS.Signals | null,
  ) => void;
  onError: (runtime: Runtime, error: Error) => void;
  /** Membership or run state changed; drives the sidebar run badges. */
  onChange: () => void;
};

const DEFAULT_IDLE_TTL_MS = 10 * 60_000;
const PRUNE_INTERVAL_MS = 60_000;
const READY_TIMEOUT_MS = 15_000;
/** start() spawns synchronously; give the fresh stdin a beat to exist. */
const STDIN_GRACE_MS = 400;

export class RuntimePool {
  /** Runtime the browser receives records from and sends commands to. */
  attached: Runtime | null = null;
  private readonly opts: RuntimePoolOptions;
  private readonly runtimes = new Set<Runtime>();
  private readonly bySession = new Map<string, Runtime>();
  /** Last attach/create target; a restart or crash reopens it. */
  private target: { sessionPath: string | null; cwd: string };
  private readonly canResume: boolean;
  private readonly pruner: ReturnType<typeof setInterval>;

  constructor(opts: RuntimePoolOptions) {
    this.opts = opts;
    this.target = { sessionPath: null, cwd: opts.cwd };
    // An in-memory bridge cannot resume a session file; attach would silently
    // start a blank session instead of the one the user clicked.
    this.canResume = !(opts.extraArgs ?? []).includes("--no-session");
    this.pruner = setInterval(() => this.pruneIdle(), PRUNE_INTERVAL_MS);
    this.pruner.unref();
  }

  /** Start the initial runtime: a fresh session in the bridge's cwd. */
  start(): Promise<Runtime> {
    return this.create(this.opts.cwd);
  }

  /**
   * Attach to the runtime of an existing session, spawning one that resumes
   * the session file when no runtime holds it yet.
   */
  async attach(sessionPath: string): Promise<Runtime> {
    const target = resolvePath(sessionPath);
    const existing = this.bySession.get(target);
    if (existing) {
      this.target = { sessionPath: target, cwd: existing.cwd };
      this.setAttached(existing);
      return existing;
    }
    if (!this.canResume) throw new Error("bridge 以 --no-session 启动，无法切换会话");
    const info = await stat(target).catch(() => null);
    if (!info?.isFile()) throw new Error("会话文件不存在");
    // `pi --session <path>` resumes the session in its own working directory.
    const cwd = (await headerCwd(target)) ?? this.opts.cwd;
    this.target = { sessionPath: target, cwd };
    return this.open(target, cwd);
  }

  /** Start a fresh session in cwd and attach to it (no restart needed). */
  async create(cwd: string): Promise<Runtime> {
    const target = resolvePath(cwd);
    const info = await stat(target).catch(() => null);
    if (!info?.isDirectory()) throw new Error("路径不是目录");
    this.target = { sessionPath: null, cwd: target };
    return this.open(null, target);
  }

  /** Reopen the last attach/create target; falls back to a fresh session. */
  async reopen(): Promise<Runtime> {
    const { sessionPath, cwd } = this.target;
    if (sessionPath && this.canResume) {
      const saved = await stat(sessionPath).catch(() => null);
      if (saved?.isFile()) return this.attach(sessionPath);
    }
    return this.create(cwd);
  }

  /** Orderly restart of the attached runtime (bridge_restart_pi). */
  async restart(): Promise<Runtime> {
    const runtime = this.attached;
    if (runtime) {
      this.target = { sessionPath: runtime.sessionPath, cwd: runtime.cwd };
      this.remove(runtime);
      await runtime.pi.stopAndWait();
    }
    return this.reopen();
  }

  /** Records to replay to a client that just hydrated from get_messages. */
  pendingRecords(): ProtocolRecord[] {
    const records = [...(this.attached?.stream ?? [])];
    const todoDetails = this.attached?.todoDetails;
    // Rides with the stream replay so the panel restores before live records
    // resume, and from bridge memory rather than a message that may be gone.
    if (todoDetails !== undefined) records.push({ type: "todo_state", details: todoDetails });
    return records;
  }

  /** Send one protocol record to the attached runtime. */
  send(record: ProtocolRecord): boolean {
    return this.attached ? this.attached.pi.send(record) : false;
  }

  /** Live runtimes, for the sidebar run badges. */
  list(): { sessionPath: string | null; running: boolean }[] {
    return [...this.runtimes].map((r) => ({ sessionPath: r.sessionPath, running: r.running }));
  }

  /**
   * Stop the runtime holding a session file so the file is no longer open
   * (Windows cannot delete an open file). Aborts its run: the caller deletes
   * the session.
   */
  async stopSession(sessionPath: string): Promise<void> {
    const runtime = this.bySession.get(resolvePath(sessionPath));
    if (!runtime) return;
    this.remove(runtime);
    await runtime.pi.stopAndWait();
  }

  /** Shutdown: stop the pruner and every runtime (bridge exit). */
  stopAll(): void {
    clearInterval(this.pruner);
    for (const runtime of this.runtimes) runtime.pi.stop();
    this.runtimes.clear();
    this.bySession.clear();
    this.attached = null;
  }

  private setAttached(runtime: Runtime): void {
    runtime.lastActive = Date.now();
    if (this.attached === runtime) return;
    this.attached = runtime;
    this.opts.onChange();
  }

  /** Spawn a runtime (resuming sessionPath when given), attach it, await its reply. */
  private async open(sessionPath: string | null, cwd: string): Promise<Runtime> {
    const runtime = this.spawn(sessionPath, cwd);
    this.setAttached(runtime);
    try {
      await this.awaitReady(runtime);
    } catch (error) {
      this.remove(runtime);
      void runtime.pi.stopAndWait();
      throw error;
    }
    return runtime;
  }

  private spawn(sessionPath: string | null, cwd: string): Runtime {
    const extraArgs = [...(this.opts.extraArgs ?? [])];
    const resume = sessionPath !== null && this.canResume;
    // The callbacks need the runtime, which is built around the process; they
    // only fire after start(), so the definite-assignment assertion is safe.
    let runtime!: Runtime;
    const pi = new PiProcess(
      {
        piPath: this.opts.piPath,
        cwd,
        extraArgs: resume ? [...extraArgs, "--session", sessionPath] : extraArgs,
      },
      {
        onRecord: (record) => this.handleRecord(runtime, record),
        onExit: (code, signal) => this.handleExit(runtime, code, signal),
        onError: (error) => this.opts.onError(runtime, error),
      },
    );
    runtime = {
      sessionPath: resume ? resolvePath(sessionPath) : null,
      pi,
      cwd,
      running: false,
      lastActive: Date.now(),
      probe: null,
      stateProbeId: null,
      stream: null,
      todoDetails: undefined,
    };
    this.runtimes.add(runtime);
    if (runtime.sessionPath) this.bySession.set(runtime.sessionPath, runtime);
    pi.start();
    this.opts.onChange();
    return runtime;
  }

  /** Resolve once the fresh pi answers a get_state probe. */
  private awaitReady(runtime: Runtime): Promise<void> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        runtime.probe = null;
        reject(new Error("pi 启动超时"));
      }, READY_TIMEOUT_MS);
      runtime.probe = {
        id,
        settle: (ok) => {
          clearTimeout(timer);
          if (ok) resolve();
          else reject(new Error("pi 启动失败"));
        },
      };
      setTimeout(() => {
        if (!runtime.probe) return;
        if (!runtime.pi.send({ type: "get_state", id })) {
          clearTimeout(timer);
          runtime.probe = null;
          reject(new Error("pi 启动失败"));
        }
      }, STDIN_GRACE_MS);
    });
  }

  private handleRecord(runtime: Runtime, record: ProtocolRecord): void {
    runtime.lastActive = Date.now();
    if (runtime.probe && record.type === "response" && record.id === runtime.probe.id) {
      const probe = runtime.probe;
      runtime.probe = null;
      this.readSessionFile(runtime, record.data);
      probe.settle(true);
    } else if (record.type === "response") {
      const isStateProbe = record.id === runtime.stateProbeId;
      if (isStateProbe) runtime.stateProbeId = null;
      if (isStateProbe || record.command === "get_state") {
        this.readSessionFile(runtime, record.data);
      }
      // Session-replacing commands move this runtime to another session file.
      const command = record.command;
      if (
        record.success &&
        (command === "new_session" || command === "switch_session" || command === "fork" || command === "clone")
      ) {
        // The replaced session had its own checklist; the new one starts empty.
        runtime.todoDetails = undefined;
        this.requestSessionFile(runtime);
      }
    } else if (runtime.sessionPath === null && (record.type === "message_end" || record.type === "agent_settled")) {
      // A fresh session is written to disk on its first message; learn the
      // path then, so attaching to it later does not spawn a second process.
      this.requestSessionFile(runtime);
    }
    // A late-attaching client replays the text already streamed; keep exactly
    // one assistant message's records so the replay never duplicates the
    // finished messages get_messages returns.
    if (record.type === "message_start") {
      const message = record.message as { role?: unknown } | null | undefined;
      runtime.stream = message?.role === "assistant" ? [record] : null;
    } else if (record.type === "message_update") {
      runtime.stream?.push(record);
    } else if (
      record.type === "message_end" ||
      record.type === "error" ||
      record.type === "agent_start" ||
      record.type === "agent_settled"
    ) {
      runtime.stream = null;
    }
    if (record.type === "tool_execution_end" && record.toolName === "todo") {
      const result = record.result as { details?: unknown } | undefined;
      if (result?.details !== undefined) runtime.todoDetails = result.details;
    }
    if (record.type === "agent_start") {
      // One checklist per task: the previous turn's list must not be replayed to
      // a client that reloads into the new turn before the agent calls set.
      runtime.todoDetails = undefined;
    }
    if (record.type === "agent_start" || record.type === "agent_settled") {
      const running = record.type === "agent_start";
      if (running !== runtime.running) {
        runtime.running = running;
        this.opts.onChange();
      }
    }
    this.opts.onRecord(runtime, record);
  }

  private handleExit(runtime: Runtime, code: number | null, signal: NodeJS.Signals | null): void {
    const wasAttached = this.attached === runtime;
    this.remove(runtime);
    runtime.probe?.settle(false);
    runtime.probe = null;
    this.opts.onExit(runtime, wasAttached, code, signal);
  }

  /** Ask pi for its current session file (one probe in flight at a time). */
  private requestSessionFile(runtime: Runtime): void {
    if (runtime.stateProbeId) return;
    const id = randomUUID();
    runtime.stateProbeId = id;
    if (!runtime.pi.send({ type: "get_state", id })) runtime.stateProbeId = null;
  }

  private readSessionFile(runtime: Runtime, data: unknown): void {
    const state = data as { sessionFile?: unknown } | null | undefined;
    if (typeof state?.sessionFile !== "string") return;
    const path = resolvePath(state.sessionFile);
    if (runtime.sessionPath === path) return;
    if (runtime.sessionPath && this.bySession.get(runtime.sessionPath) === runtime) {
      this.bySession.delete(runtime.sessionPath);
    }
    runtime.sessionPath = path;
    this.bySession.set(path, runtime);
    this.opts.onChange();
  }

  private remove(runtime: Runtime): void {
    if (!this.runtimes.delete(runtime)) return;
    if (runtime.sessionPath && this.bySession.get(runtime.sessionPath) === runtime) {
      this.bySession.delete(runtime.sessionPath);
    }
    if (this.attached === runtime) this.attached = null;
    this.opts.onChange();
  }

  /** Stop background runtimes that have been idle past the TTL. */
  private pruneIdle(): void {
    const ttl = this.opts.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    const now = Date.now();
    for (const runtime of [...this.runtimes]) {
      if (runtime === this.attached || runtime.running) continue;
      if (now - runtime.lastActive < ttl) continue;
      this.remove(runtime);
      void runtime.pi.stopAndWait();
    }
  }
}