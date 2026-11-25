// Running `git` for the Git view. Arguments are always argv (never a shell),
// output is capped so a pathological diff cannot exhaust the bridge, and every
// failure mode (missing binary, timeout, non-zero exit) comes back as a value
// instead of a rejection so callers can turn it into a user-visible error.
import { spawn } from "node:child_process";
import type { GitErrorCode } from "./types.ts";

/** Read output cap, matching the file preview endpoint's 1 MB budget. */
export const OUTPUT_CAP = 1_000_000;
export const LOCAL_TIMEOUT_MS = 30_000;
/** Network commands (fetch/pull/push) can legitimately take longer. */
export const NETWORK_TIMEOUT_MS = 120_000;

export type GitRun = {
  code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  spawnError: string | null;
};

export type GitRunOptions = {
  timeoutMs?: number;
  /** Text written to the child's stdin, then EOF (patch input). */
  input?: string;
};

/**
 * Run git in `cwd`. Environment is fixed so the bridge can never block on a
 * credential or editor prompt: network commands fail fast instead of hanging.
 */
export function runGit(cwd: string, args: string[], options: GitRunOptions = {}): Promise<GitRun> {
  return new Promise((resolve) => {
    const child = spawn(
      "git",
      // GIT_OPTIONAL_LOCKS=0: status-derived reads run while pi may be writing,
      // and no read here needs to take the index lock.
      ["--no-pager", "-c", "core.quotepath=false", ...args],
      {
        cwd,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_EDITOR: "true",
          GIT_MERGE_AUTOEDIT: "no",
        },
        windowsHide: true,
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let truncated = false;
    // One byte budget across both streams; extra output is drained and dropped.
    const collect = (target: Buffer[]) => (chunk: Buffer): void => {
      const room = OUTPUT_CAP - size;
      if (room <= 0) {
        truncated = true;
        return;
      }
      if (chunk.length > room) {
        truncated = true;
        target.push(chunk.subarray(0, room));
        size = OUTPUT_CAP;
        return;
      }
      target.push(chunk);
      size += chunk.length;
    };
    const text = (chunks: Buffer[]): string => Buffer.concat(chunks).toString("utf-8");
    let settled = false;
    const finish = (result: GitRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({
        code: null,
        stdout: text(stdout),
        stderr: text(stderr),
        truncated,
        timedOut: true,
        spawnError: null,
      });
    }, options.timeoutMs ?? LOCAL_TIMEOUT_MS);
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", (error: Error) => {
      finish({
        code: null,
        stdout: text(stdout),
        stderr: text(stderr),
        truncated,
        timedOut: false,
        spawnError: error.message,
      });
    });
    child.on("close", (code: number | null) => {
      finish({ code, stdout: text(stdout), stderr: text(stderr), truncated, timedOut: false, spawnError: null });
    });
    // Always close stdin: a command that decides to read it (an editor, a
    // credential helper) must see EOF rather than wait for the bridge.
    child.stdin.on("error", () => {
      // The child may exit before consuming the patch; that is reported by
      // the exit code, not by this stream.
    });
    child.stdin.end(options.input ?? "");
  });
}

/** True when git ran and exited 0. */
export function succeeded(run: GitRun): boolean {
  return run.spawnError === null && !run.timedOut && run.code === 0;
}

/** First non-empty line of stderr, or a fallback naming the failed command. */
export function errorText(run: GitRun, label: string): string {
  if (run.spawnError) return `cannot run git: ${run.spawnError}`;
  if (run.timedOut) return `${label} timed out`;
  const line = run.stderr
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return line ?? `${label} failed (exit ${run.code ?? "?"})`;
}

/** Classify a failure so the page can offer a next step instead of a dead end. */
export function errorCode(run: GitRun): GitErrorCode {
  if (run.spawnError) return "git-missing";
  if (run.timedOut) return "timeout";
  if (/index\.lock/i.test(run.stderr)) return "index-locked";
  return "failed";
}