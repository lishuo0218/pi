// File browser for the agent's working directory: each folder is read from the
// bridge only when it is opened, so .git or node_modules cost nothing until
// asked for. Clicking a file opens it in the preview column.
import { useEffect, useState } from "preact/hooks";
import type { JSX } from "preact";
import { FileIcon } from "./file-icon";
import { openPreview } from "./preview-target";
import { IconFolder, IconFolderOpen, IconRefresh } from "./icons";
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

export function FileTree({ cwd, theme }: { cwd: string | null; theme: Theme }): JSX.Element {
  const [reload, setReload] = useState(0);
  return (
    <section class="side-section tree-section">
      <div class="side-section-head">
        <span class="side-section-title">文件</span>
        <button
          class="side-refresh"
          title="重新读取目录"
          onClick={() => setReload((n) => n + 1)}
        >
          <IconRefresh size={14} />
        </button>
      </div>
      {cwd === null ? (
        <div class="side-empty">pi 启动后这里会显示工作目录的文件。</div>
      ) : (
        <div class="tree-scroll">
          <ul class="tree-list">
            <DirNode name={cwdName(cwd)} path="" depth={0} title={cwd} theme={theme} reload={reload} initiallyOpen />
          </ul>
        </div>
      )}
    </section>
  );
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
  reload,
  initiallyOpen = false,
}: {
  name: string;
  path: string;
  depth: number;
  title?: string;
  theme: Theme;
  reload: number;
  initiallyOpen?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <li class="tree-node">
      <button class="tree-row" style={indent(depth)} title={title ?? name} onClick={() => setOpen(!open)}>
        {open ? <IconFolderOpen size={14} /> : <IconFolder size={14} />}
        <span class="tree-name">{name}</span>
      </button>
      {open ? <DirChildren path={path} depth={depth + 1} theme={theme} reload={reload} /> : null}
    </li>
  );
}

function DirChildren({
  path,
  depth,
  theme,
  reload,
}: {
  path: string;
  depth: number;
  theme: Theme;
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
              onClick={() => openPreview(childPath)}
            >
              <FileIcon path={childPath} theme={theme} />
              <span class="tree-name">{entry.name}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}