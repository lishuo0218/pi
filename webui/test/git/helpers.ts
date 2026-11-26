// Test fixtures: real git repositories in temp directories, driven by the same
// argv-level git the bridge calls, so the tests exercise git's actual output
// instead of hand-written porcelain strings.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { handleGit } from "../../bridge/git/index.ts";
import type { GitDiff, GitResult, GitStatus } from "../../bridge/git/types.ts";

const exec = promisify(execFile);

export type Fixture = { dir: string; cleanup: () => Promise<void> };

/** Run git in `dir` and return stdout; a non-zero exit rejects. */
export async function git(
  dir: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const { stdout } = await exec("git", ["-c", "core.quotepath=false", ...args], {
    cwd: dir,
    env,
    windowsHide: true,
  });
  return stdout;
}

/** Write `text` to `path` under `dir`, creating parent directories. */
export async function write(dir: string, path: string, text: string): Promise<void> {
  const full = join(dir, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, text, "utf-8");
}

async function temp(prefix: string): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { dir, cleanup: () => removeDir(dir) };
}

/**
 * Remove a fixture directory. Windows keeps a directory locked while a child
 * that was just killed still holds it as its working directory, so a stale
 * lock is retried briefly instead of failing the whole file.
 */
async function removeDir(dir: string, attempt = 0): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (attempt >= 9 || (code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "EPERM")) throw error;
    await new Promise((resolve) => setTimeout(resolve, 100));
    await removeDir(dir, attempt + 1);
  }
}

/** An empty directory that is not a repository. */
export function makeDir(): Promise<Fixture> {
  return temp("pi-webui-norepo-");
}

/** A repository with one empty initial commit on `main`. */
export async function makeRepo(): Promise<Fixture> {
  const fixture = await temp("pi-webui-git-");
  await git(fixture.dir, ["init", "-q", "-b", "main"]);
  await git(fixture.dir, ["commit", "-q", "--allow-empty", "-m", "init"]);
  return fixture;
}

/** Stage everything and commit it; returns the new commit's sha. */
export async function commitAll(dir: string, message: string): Promise<string> {
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", message]);
  return (await git(dir, ["rev-parse", "HEAD"])).trim();
}

/** `count` numbered lines, the body of the multi-line fixtures. */
export function lines(count: number, prefix = "line"): string {
  return Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join("\n") + "\n";
}

/** Remove every fixture created by a test file. */
export function cleanupAll(fixtures: Fixture[]): Promise<void[]> {
  return Promise.all(fixtures.map((fixture) => fixture.cleanup()));
}
/** Send one request through the bridge's dispatcher, as the page would. */
export async function call(cwd: string, body: unknown, piPath = "pi"): Promise<GitResult> {
  return handleGit(body, cwd, piPath);
}

/** The status of a successful status reply; fails the calling test otherwise. */
export function statusOf(reply: GitResult): GitStatus {
  if (!reply.ok || reply.action !== "status") throw new Error(`expected status, got ${JSON.stringify(reply)}`);
  return reply.status;
}

/** The patch of a successful diff reply. */
export function diffOf(reply: GitResult): GitDiff {
  if (!reply.ok || reply.action !== "diff") throw new Error(`expected diff, got ${JSON.stringify(reply)}`);
  return reply.diff;
}

/** The error code of a failed reply. */
export function errorOf(reply: GitResult): { error: string; code: string } {
  if (reply.ok) throw new Error(`expected an error, got ${JSON.stringify(reply)}`);
  return { error: reply.error, code: reply.code };
}
