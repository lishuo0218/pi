// Manage the pi --mode rpc child process: spawn, wire stdin/stdout JSONL to
// listeners, report lifecycle (version, exit) so the UI can prompt for restart.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { execFile } from "node:child_process";
import { FrameDecoder } from "./frames.ts";

export type ProtocolRecord = Record<string, unknown>;

export type PiProcessEvents = {
  onRecord: (record: ProtocolRecord) => void;
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  onError: (error: Error) => void;
};

export type SpawnOptions = {
  /** Path or name of the pi executable. Defaults to "pi" (resolved via PATH). */
  piPath: string;
  /** Working directory for the pi session. */
  cwd: string;
  /** Extra CLI args forwarded to pi, e.g. ["--no-session"]. */
  extraArgs?: string[];
};

/** Read `pi --version` once at bridge startup, for the protocol-match warning. */
export function readPiVersion(piPath: string): Promise<string> {
  const { command, args, shell } = piInvocation(piPath, ["--version"]);
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 10_000, shell }, (err, stdout) => {
      resolve(err ? "" : stdout.trim());
    });
  });
}

/**
 * Build the executable call for a pi path. A `.js`/`.mjs` entry is a source or
 * bundle checkout, so run it with this Node binary; `.cmd`/`.bat` shims on
 * Windows cannot be spawned directly and go through cmd.exe.
 */
function piInvocation(
  piPath: string,
  args: string[],
): { command: string; args: string[]; shell: boolean } {
  if (/\.(m?js)$/i.test(piPath)) {
    return { command: process.execPath, args: [piPath, ...args], shell: false };
  }
  const shell = process.platform === "win32" && /\.(cmd|bat)$/i.test(piPath);
  return { command: piPath, args, shell };
}

export class PiProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private decoder: FrameDecoder | null = null;
  readonly events: PiProcessEvents;
  readonly opts: SpawnOptions;

  constructor(opts: SpawnOptions, events: PiProcessEvents) {
    this.opts = opts;
    this.events = events;
  }

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  /** Ordered exits seen so far — lets stop() suppress onExit for its target. */
  private stopped = new Set<ChildProcessWithoutNullStreams>();

  start(): void {
    if (this.running) return;
    const { command, args, shell } = piInvocation(this.opts.piPath, [
      "--mode",
      "rpc",
      ...(this.opts.extraArgs ?? []),
    ]);
    const child = spawn(command, args, {
      cwd: this.opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell,
    });
    this.child = child;

    // Continuous reading is mandatory: pi honors stdout backpressure and a
    // stopped reader stalls it (protocol docs: rpc.md "Framing").
    this.decoder = new FrameDecoder((line) => {
      let record: ProtocolRecord;
      try {
        record = JSON.parse(line) as ProtocolRecord;
      } catch {
        // Malformed record from pi itself; surface as-is rather than crash.
        record = { type: "bridge_error", error: "unparseable record from pi", raw: line };
      }
      this.events.onRecord(record);
    });
    child.stdout.on("data", (chunk: Buffer) => this.decoder?.push(chunk));
    child.stdout.on("end", () => this.decoder?.end());

    child.stderr.on("data", (chunk: Buffer) => {
      // stderr is diagnostics, never protocol data; forward to bridge stderr.
      process.stderr.write(`[pi stderr] ${chunk.toString("utf8")}`);
    });

    child.on("error", (error) => this.events.onError(error));
    child.on("exit", (code, signal) => {
      // Identity guard: restartPi() spawns the replacement before the old
      // process finishes draining, so a stale child's exit must not clobber
      // the freshly spawned one (that orphaned it and failed the cwd probe).
      if (this.child !== child) return;
      // An orderly stop() already signalled shutdown — no crash/restart.
      if (this.stopped.delete(child)) return;
      this.child = null;
      this.events.onExit(code, signal);
    });
  }

  /** Write one protocol record to pi's stdin (JSONL, LF-terminated). */
  send(record: ProtocolRecord): boolean {
    if (!this.running || !this.child) return false;
    this.child.stdin.write(JSON.stringify(record) + "\n");
    return true;
  }

  /** Orderly shutdown: close stdin first, pi exits after pending work drains. */
  stop(): void {
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    // Mark as deliberately stopped: its later exit is shutdown, not a crash,
    // so the exit handler must not fire onExit (no auto-restart cascade).
    this.stopped.add(child);
    child.stdin.end();
    // Give the orderly shutdown a grace period, then force-kill the tree.
    const killTimer = setTimeout(() => {
      if (child.exitCode === null) {
        if (process.platform === "win32") {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
        } else {
          child.kill("SIGKILL");
        }
      }
    }, 5_000);
    killTimer.unref();
    child.once("exit", () => {
      this.stopped.delete(child);
      clearTimeout(killTimer);
    });
  }

  /**
   * stop() and wait until the child is gone. The session file of a stopped
   * runtime stays open until exit, and Windows cannot delete an open file.
   */
  stopAndWait(): Promise<void> {
    const child = this.child;
    if (!child) return Promise.resolve();
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    this.stop();
    return exited;
  }
}
