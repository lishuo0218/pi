// Commit history for the Git view: one page of `git log`, parsed from a
// record-separated format so subjects may contain anything, plus the ref
// decorations of each commit (branches, remote-tracking refs, tags) so the
// history column can badge them. An unborn branch has no commits yet, which is
// an empty history rather than an error.
import { errorText, runGit, succeeded } from "./exec.ts";
import type { Repo } from "./repo.ts";
import type { GitCommit, GitRef, GitResult } from "./types.ts";

/** Fields of one commit, separated by US (0x1f); commits by RS (0x1e). */
const FORMAT = "%H%x1f%h%x1f%an%x1f%ad%x1f%D%x1f%s%x1e";

/**
 * Names of the configured remotes. `%D` prints `origin/main` for a
 * remote-tracking ref but `feature/x` for a local branch with a slash, so the
 * remote list is what tells the two apart.
 */
async function remoteNames(repo: Repo): Promise<string[]> {
  const run = await runGit(repo.root, ["remote"]);
  if (!succeeded(run)) return [];
  return run.stdout
    .split("\n")
    .map((name) => name.trim())
    .filter((name) => name !== "");
}

/** Parse one `%D` decoration string into typed refs. */
function parseRefs(decoration: string, remotes: string[]): GitRef[] {
  const refs: GitRef[] = [];
  for (const part of decoration.split(",")) {
    const entry = part.trim();
    if (entry === "") continue;
    // `HEAD -> main` and `origin/HEAD -> origin/main` mark the checked-out and
    // the default branch; the name after the arrow is the ref worth showing.
    const arrow = entry.lastIndexOf(" -> ");
    const name = arrow === -1 ? entry : entry.slice(arrow + 4);
    if (name === "HEAD") continue;
    if (name.startsWith("tag: ")) {
      refs.push({ kind: "tag", name: name.slice("tag: ".length) });
      continue;
    }
    const remote = remotes.find((prefix) => name.startsWith(`${prefix}/`));
    refs.push({ kind: remote === undefined ? "branch" : "remote", name });
  }
  return refs;
}

/** One page of history, newest first, with `hasMore` for the next request. */
export async function readLog(repo: Repo, limit: number, skip: number): Promise<GitResult> {
  const remotes = await remoteNames(repo);
  const run = await runGit(repo.root, [
    "log",
    // Piped output would otherwise follow `log.decorate` from the user's config,
    // which decides whether `%D` has anything to print.
    "--decorate=short",
    `--skip=${skip}`,
    `-n`,
    String(limit + 1),
    "--date=format:%Y-%m-%d %H:%M",
    `--pretty=format:${FORMAT}`,
  ]);
  if (!succeeded(run)) {
    if (run.stderr.includes("does not have any commits") || run.stderr.includes("unknown revision")) {
      return { ok: true, action: "commits", commits: [], hasMore: false };
    }
    return { ok: false, error: errorText(run, "git log"), code: "failed" };
  }
  const commits: GitCommit[] = [];
  for (const record of run.stdout.split("\x1e")) {
    const line = record.replace(/^\n/, "");
    if (line === "") continue;
    const [sha, short, author, date, decoration, ...subject] = line.split("\x1f");
    if (!sha || !short || !author || !date) continue;
    commits.push({
      sha,
      short,
      author,
      date,
      subject: subject.join("\x1f"),
      refs: parseRefs(decoration ?? "", remotes),
    });
  }
  const hasMore = commits.length > limit;
  return { ok: true, action: "commits", commits: hasMore ? commits.slice(0, limit) : commits, hasMore };
}