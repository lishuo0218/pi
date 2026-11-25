// Commit history for the Git view: one page of `git log`, parsed from a
// record-separated format so subjects may contain anything, plus the ref
// decorations of each commit (branches, remote-tracking refs, tags) and its
// parents, which the history column turns into graph lanes. The same walk
// answers a literal search: git matches `--grep` and `--author` with AND, so
// the two match sets are read separately and merged newest first.
import { errorText, runGit, succeeded } from "./exec.ts";
import type { Repo } from "./repo.ts";
import type { GitCommit, GitRef, GitResult } from "./types.ts";

/** Fields of one commit, separated by US (0x1f); commits by RS (0x1e). */
const FORMAT = "%H%x1f%h%x1f%an%x1f%ad%x1f%D%x1f%P%x1f%ct%x1f%s%x1e";

/**
 * Search reads this many matching commits from each match set before paging.
 * A deeper page than this would make one search read the whole history of a
 * large repository, so the column simply ends there.
 */
const SEARCH_CAP = 1_000;

/** A parsed commit plus the commit time the merged search sorts on. */
type Entry = { commit: GitCommit; epoch: number };

/** A log read either produced entries or failed with git's own message. */
type LogPage = { entries: Entry[]; more: boolean } | { error: string };

/**
 * Names of the configured remotes. `%D` prints `origin/main` for a
 * remote-tracking ref but `feature/x` for a local branch with a slash, so the
 * remote list is what tells the two apart.
 */
export async function remoteNames(repo: Repo): Promise<string[]> {
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

function parseEntries(text: string, remotes: string[]): Entry[] {
  const entries: Entry[] = [];
  for (const record of text.split("\x1e")) {
    const line = record.replace(/^\n/, "");
    if (line === "") continue;
    const [sha, short, author, date, decoration, parentText, epochText, ...subject] = line.split("\x1f");
    if (!sha || !short || !author || !date) continue;
    const epoch = Number(epochText);
    entries.push({
      commit: {
        sha,
        short,
        author,
        date,
        subject: subject.join("\x1f"),
        parents: (parentText ?? "").split(" ").filter((parent) => parent !== ""),
        refs: parseRefs(decoration ?? "", remotes),
      },
      epoch: Number.isFinite(epoch) ? epoch : 0,
    });
  }
  return entries;
}

/** One log read starting at `extra` arguments (a rev or `--all` plus filters). */
async function runLog(
  repo: Repo,
  remotes: string[],
  extra: string[],
  limit: number,
  skip: number,
): Promise<LogPage> {
  const run = await runGit(repo.root, [
    "log",
    // Piped output would otherwise follow `log.decorate` from the user's config,
    // which decides whether `%D` has anything to print.
    "--decorate=short",
    // The lane layout draws a line down to every parent, so a parent must come
    // after its children. The default order is by commit date alone, and with
    // several starting points (`--all` also starts at tags) a parent that shares
    // its timestamp with its child can print first, leaving a lane that never
    // reaches a commit.
    "--date-order",
    ...extra,
    `--skip=${skip}`,
    "-n",
    String(limit),
    "--date=format:%Y-%m-%d %H:%M",
    `--pretty=format:${FORMAT}`,
  ]);
  if (!succeeded(run)) {
    if (run.stderr.includes("does not have any commits") || run.stderr.includes("unknown revision")) {
      return { entries: [], more: false };
    }
    return { error: errorText(run, "git log") };
  }
  const entries = parseEntries(run.stdout, remotes);
  return { entries, more: entries.length === limit };
}

async function readCommitEntry(repo: Repo, remotes: string[], sha: string): Promise<Entry | null> {
  const page = await runLog(repo, remotes, [sha], 1, 0);
  if ("error" in page) return null;
  return page.entries[0] ?? null;
}

/** A single commit, with the refs and parents of the requested sha. */
export async function readCommit(repo: Repo, sha: string): Promise<GitCommit | null> {
  const entry = await readCommitEntry(repo, await remoteNames(repo), sha);
  return entry?.commit ?? null;
}

/**
 * Resolve a hex query to a commit, so searching a full or abbreviated sha finds
 * it even though git's message and author filters cannot match a sha.
 */
async function resolveSha(repo: Repo, query: string): Promise<string | null> {
  if (!/^[0-9a-f]{4,40}$/i.test(query)) return null;
  const run = await runGit(repo.root, ["rev-parse", "--verify", "--quiet", `${query}^{commit}`]);
  if (!succeeded(run)) return null;
  const sha = run.stdout.trim();
  return sha === "" ? null : sha;
}

/**
 * Merge the message matches, the author matches and the commit a hex query
 * names, newest commit first. Both streams are complete from the start of the
 * walk, so a page can be cut consistently at `skip`; commits git ordered by
 * graph are re-ordered by commit time here, which is only visible in search.
 */
function mergeMatches(sets: Entry[][]): Entry[] {
  const bySha = new Map<string, Entry>();
  for (const set of sets) {
    for (const entry of set) {
      if (!bySha.has(entry.commit.sha)) bySha.set(entry.commit.sha, entry);
    }
  }
  return [...bySha.values()].sort((left, right) => {
    if (left.epoch !== right.epoch) return right.epoch - left.epoch;
    return left.commit.sha < right.commit.sha ? -1 : 1;
  });
}

function commitsResult(entries: Entry[], hasMore: boolean): GitResult {
  return { ok: true, action: "commits", commits: entries.map((entry) => entry.commit), hasMore };
}

/** One page of history, newest first, with `hasMore` for the next request. */
export async function readLog(
  repo: Repo,
  request: { limit: number; skip: number; rev: string | null; all: boolean; query: string | null },
): Promise<GitResult> {
  const remotes = await remoteNames(repo);
  const base: string[] = [];
  if (request.all) base.push("--all");
  else if (request.rev !== null) base.push(request.rev);

  if (request.query === null) {
    const page = await runLog(repo, remotes, base, request.limit + 1, request.skip);
    if ("error" in page) return { ok: false, error: page.error, code: "failed" };
    return commitsResult(page.entries.slice(0, request.limit), page.entries.length > request.limit);
  }

  // The merged page needs every match up to `skip + limit`, so both streams
  // read from the start of the walk instead of from `skip`.
  if (request.skip >= SEARCH_CAP) return commitsResult([], false);
  const want = Math.min(request.skip + request.limit + 1, SEARCH_CAP);
  const flags = ["--fixed-strings", "-i"];
  const [byMessage, byAuthor, sha] = await Promise.all([
    runLog(repo, remotes, [...base, ...flags, `--grep=${request.query}`], want, 0),
    runLog(repo, remotes, [...base, ...flags, `--author=${request.query}`], want, 0),
    resolveSha(repo, request.query),
  ]);
  if ("error" in byMessage) return { ok: false, error: byMessage.error, code: "failed" };
  if ("error" in byAuthor) return { ok: false, error: byAuthor.error, code: "failed" };

  const sets = [byMessage.entries, byAuthor.entries];
  if (sha !== null) {
    const seen = sets.some((set) => set.some((entry) => entry.commit.sha === sha));
    const target = seen ? null : await readCommitEntry(repo, remotes, sha);
    if (target !== null) sets.push([target]);
  }
  const merged = mergeMatches(sets);
  return commitsResult(
    merged.slice(request.skip, request.skip + request.limit),
    merged.length > request.skip + request.limit || byMessage.more || byAuthor.more,
  );
}
