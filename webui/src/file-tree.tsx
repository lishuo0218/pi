// File browser for the agent's working directory: each folder is read from the
// bridge only when it is opened, so .git or node_modules cost nothing until
// asked for. Clicking a file opens it in the preview column. Rows also carry the
// path's git tracking state, read from the shared status snapshot, and can be
// dragged into the composer as an absolute path.
import { useEffect, useState } from "preact/hooks";
import { useSyncExternalStore } from "preact/compat";
import type { JSX } from "preact";
import { FileIcon } from "./file-icon";
import { openPreview } from "./preview-target";
import { IconFolder, IconFolderOpen, IconRefresh } from "./icons";
import { repoPath, repoPrefix, treeStatus, type DirChange, type TrackMark } from "./git/tree-status";
import { pathDragPath, startPathDrag } from "./path-drag";
import type { Theme } from "./theme";

type Entry = { name: string; dir: boolean };
type Listing = { entries: Entry[]; error?: string };

/** One directory level from /api/list-dir. Wire input, so the shape is checked. */
async function listDir(path: string): Promise<Listing> {
  try {
    const res = await fetch("/api/list-dir", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    });
    if (!res.ok) return { entries: [], error: `无法读取目录（${res.status}）` };
    const data = (await res.json()) as { entries?: unknown; error?: unknown } | null;
    const raw = Array.isArray(data?.entries) ? data.entries : [];
    const entries: Entry[] = [];
    for (const item of raw) {
      const entry = item as { name?: unknown; dir?: unknown } | null;
      if (typeof entry?.name === "string" && typeof entry.dir === "boolean") {
        entries.push({ name: entry.name, dir: entry.dir });
      }
    }
    return typeof data?.error === "string" ? { entries, error: data.error } : { entries };
  } catch (error) {
    return { entries: [], error: error instanceof Error ? error.message : String(error) };
  }
}

/** Indent by depth; rows carry it inline because depth varies per node. */
function indent(depth: number): { paddingLeft: string } {
  return { paddingLeft: `${8 + depth * 12}px` };
}

/**
 * Stable identities for useSyncExternalStore: it re-subscribes whenever
 * `subscribe` changes, and this store stops and clears on its last unsubscribe,
 * so a fresh closure per render would reload the status in a loop.
 */
const subscribeTreeStatus = (callback: () => void): (() => void) => treeStatus.subscribe(callback);
const treeStatusVersion = (): number => treeStatus.version;

export function FileTree({ cwd, theme }: { cwd: string | null; theme: Theme }): JSX.Element {
  const [reload, setReload] = useState(0);
  useSyncExternalStore(subscribeTreeStatus, treeStatusVersion);
  // Path from the repository top level to the browsed directory; null when the
  // working directory is not inside a repository (no marks to show).
  const root = treeStatus.root;
  const prefix = cwd === null || root === null ? null : repoPrefix(root, cwd);
  return (
    <section class="side-section tree-section">
      <div class="side-section-head">
        <span class="side-section-title">文件</span>
        <button
          class="side-refresh"
          title="重新读取目录与 git 状态"
          onClick={() => {
            setReload((n) => n + 1);
            void treeStatus.refresh();
          }}
        >
          <IconRefresh size={14} />
        </button>
      </div>
      {cwd === null ? (
        <div class="side-empty">pi 启动后这里会显示工作目录的文件。</div>
      ) : (
        <div class="tree-scroll">
          <ul class="tree-list">
            <DirNode
              name={cwdName(cwd)}
              path=""
              depth={0}
              title={cwd}
              theme={theme}
              cwd={cwd}
              prefix={prefix}
              reload={reload}
              initiallyOpen
            />
          </ul>
        </div>
      )}
    </section>
  );
}

/** Tooltip of a directory dot: the strongest pending change underneath it. */
function dotTitle(change: DirChange): string {
  switch (change) {
    case "conflict":
      return "目录内有冲突文件";
    case "worktree":
      return "目录内有未暂存改动";
    case "staged":
      return "目录内仅有已暂存改动";
    case "untracked":
      return "目录内仅有未跟踪文件";
  }
}

/** Last path segment of the working directory, for the tree root label. */
function cwdName(cwd: string): string {
  const parts = cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts.at(-1) || cwd;
}

function DirNode({
  name,
  path,
  depth,
  title,
  theme,
  cwd,
  prefix,
  reload,
  initiallyOpen = false,
}: {
  name: string;
  path: string;
  depth: number;
  title?: string;
  theme: Theme;
  /** pi's working directory; tree paths are relative to it. */
  cwd: string;
  /** Repo-relative path of the browsed directory, or null outside a repo. */
  prefix: string | null;
  reload: number;
  initiallyOpen?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(initiallyOpen);
  const change = prefix === null ? null : treeStatus.dirMark(repoPath(prefix, path));
  return (
    <li class="tree-node">
      <button
        class="tree-row"
        style={indent(depth)}
        title={title ?? name}
        draggable
        onDragStart={(e) => startPathDrag(e, pathDragPath(cwd, path))}
        onClick={() => setOpen(!open)}
      >
        {open ? <IconFolderOpen size={14} /> : <IconFolder size={14} />}
        <span class="tree-name">{name}</span>
        {change === null ? null : <span class={`tree-dot ${change}`} title={dotTitle(change)} />}
      </button>
      {open ? (
        <DirChildren path={path} depth={depth + 1} theme={theme} cwd={cwd} prefix={prefix} reload={reload} />
      ) : null}
    </li>
  );
}

function DirChildren({
  path,
  depth,
  theme,
  cwd,
  prefix,
  reload,
}: {
  path: string;
  depth: number;
  theme: Theme;
  cwd: string;
  prefix: string | null;
  reload: number;
}): JSX.Element {
  const [listing, setListing] = useState<Listing | null>(null);
  useEffect(() => {
    let live = true;
    void listDir(path).then((result) => {
      if (live) setListing(result);
    });
    return () => {
      live = false;
    };
  }, [path, reload]);

  // A reload keeps the previous listing mounted, so open folders stay open
  // while their contents are read again.
  if (listing === null) {
    return (
      <div class="tree-note" style={indent(depth)}>
        读取中…
      </div>
    );
  }
  if (listing.error !== undefined) {
    return (
      <div class="tree-note err" style={indent(depth)}>
        {listing.error}
      </div>
    );
  }
  if (listing.entries.length === 0) {
    return (
      <div class="tree-note" style={indent(depth)}>
        （空目录）
      </div>
    );
  }
  return (
    <ul class="tree-list">
      {listing.entries.map((entry) => {
        const childPath = path === "" ? entry.name : `${path}/${entry.name}`;
        if (entry.dir) {
          return (
            <DirNode
              key={entry.name}
              name={entry.name}
              path={childPath}
              depth={depth}
              theme={theme}
              cwd={cwd}
              prefix={prefix}
              reload={reload}
            />
          );
        }
        return (
          <li key={entry.name} class="tree-node">
            <button
              class="tree-row file-row"
              style={indent(depth)}
              title={childPath}
              draggable
              onDragStart={(e) => startPathDrag(e, pathDragPath(cwd, childPath))}
              onClick={() => openPreview(childPath)}
            >
              <FileIcon path={childPath} theme={theme} />
              <span class="tree-name">{entry.name}</span>
              <FileBadges mark={prefix === null ? null : treeStatus.mark(repoPath(prefix, childPath))} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Row-end badges for a path's pending change: the staged letter first, then the
 * worktree letter. An untracked path gets a single U, a conflicted one a single
 * !, because neither side is meaningful there.
 */
function FileBadges({ mark }: { mark: TrackMark | null }): JSX.Element | null {
  if (mark === null) return null;
  if (mark.conflict) {
    return (
      <span class="tree-badges">
        <Badge tone="conflict" letter="!" />
      </span>
    );
  }
  if (mark.untracked) {
    return (
      <span class="tree-badges">
        <Badge tone="untracked" letter="U" />
      </span>
    );
  }
  if (mark.staged === null && mark.worktree === null) return null;
  return (
    <span class="tree-badges">
      {mark.staged === null ? null : <Badge tone="staged" letter={mark.staged} />}
      {mark.worktree === null ? null : <Badge tone="worktree" letter={mark.worktree} />}
    </span>
  );
}

function Badge({ tone, letter }: { tone: "staged" | "worktree" | "untracked" | "conflict"; letter: string }): JSX.Element {
  return <span class={`tree-badge ${tone}`}>{letter}</span>;
}