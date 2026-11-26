// Changed-file column of the Git view: conflicts first, then the index side,
// then the worktree side with untracked files last. A partially staged file is
// one row per side, and every row counts, opens and acts on its own side only.
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { GitFile, GitLineStats, GitSide, GitStatus } from "../../bridge/git/types";
import { IconCheck, IconChevron, IconDiscard, IconStage, IconTrash, IconUnstage } from "../icons";
import { Collapse } from "../collapse";
import { pathParts } from "./path-parts";
import type { GitStore } from "./store";

type SectionKey = "conflicts" | "staged" | "changes";

type Section = {
  key: SectionKey;
  title: string;
  /** Side of the diff a row opens; null for conflicts. */
  side: GitSide | null;
  files: GitFile[];
};

function sectionsOf(status: GitStatus): Section[] {
  const conflicts: GitFile[] = [];
  const staged: GitFile[] = [];
  const changed: GitFile[] = [];
  const untracked: GitFile[] = [];
  for (const file of status.files) {
    if (file.conflict !== null) conflicts.push(file);
    else if (file.untracked) untracked.push(file);
    else {
      if (file.index !== ".") staged.push(file);
      if (file.worktree !== ".") changed.push(file);
    }
  }
  return [
    { key: "conflicts", title: "冲突", side: null, files: conflicts },
    { key: "staged", title: "已暂存", side: "index", files: staged },
    { key: "changes", title: "更改", side: "worktree", files: [...changed, ...untracked] },
  ];
}

/** `+n −n` of one side; a binary patch reports null counts and shows nothing. */
function LineStats({ stats }: { stats: GitLineStats | null }): JSX.Element | null {
  if (stats === null || (stats.add === null && stats.del === null)) return null;
  return (
    <span class="gv-stats">
      {stats.add === null || stats.add === 0 ? null : <span class="gv-add-count">+{stats.add}</span>}
      {stats.del === null || stats.del === 0 ? null : <span class="gv-del-count">−{stats.del}</span>}
    </span>
  );
}

/** One icon-only row action; stops the click so it never opens the patch. */
function RowButton({
  title,
  danger = false,
  disabled,
  onClick,
  children,
}: {
  title: string;
  danger?: boolean;
  disabled: boolean;
  onClick: () => void;
  children: JSX.Element;
}): JSX.Element {
  return (
    <button
      class={`gv-icon-btn${danger ? " danger" : ""}`}
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );
}

export function GitChanges({ store, status }: { store: GitStore; status: GitStatus }): JSX.Element {
  const [collapsed, setCollapsed] = useState<ReadonlySet<SectionKey>>(new Set());
  const sections = sectionsOf(status).filter((section) => section.files.length > 0);

  const toggle = (key: SectionKey): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (sections.length === 0) {
    return <p class="gv-empty">工作区干净</p>;
  }

  return (
    <div class="gv-changes">
      {sections.map((section) => (
        <section class="gv-group" key={section.key}>
          <GroupHead
            store={store}
            section={section}
            collapsed={collapsed.has(section.key)}
            onToggle={() => toggle(section.key)}
          />
          <Collapse open={!collapsed.has(section.key)}>
            {section.files.map((file) => (
              <FileRow
                key={`${section.key}:${file.path}`}
                store={store}
                section={section}
                file={file}
                active={isOpen(store, section, file)}
              />
            ))}
          </Collapse>
        </section>
      ))}
    </div>
  );
}

function isOpen(store: GitStore, section: Section, file: GitFile): boolean {
  const selection = store.selection;
  return (
    selection !== null &&
    selection.kind === "file" &&
    selection.path === file.path &&
    section.side !== null &&
    selection.side === section.side
  );
}

/** Section header: caret + title + count, then the bulk actions of that side. */
function GroupHead({
  store,
  section,
  collapsed,
  onToggle,
}: {
  store: GitStore;
  section: Section;
  collapsed: boolean;
  onToggle: () => void;
}): JSX.Element {
  const busy = store.busy;
  const paths = section.files.map((file) => file.path);
  const changed = section.files.filter((file) => !file.untracked).map((file) => file.path);
  const untracked = section.files.filter((file) => file.untracked).map((file) => file.path);

  return (
    <div class="gv-group-head">
      <button class="gv-group-toggle" onClick={onToggle} title={collapsed ? "展开" : "折叠"}>
        <span class={`caret gv-caret${collapsed ? "" : " open"}`}>
          <IconChevron />
        </span>
        <span class="gv-group-title">{section.title}</span>
        <span class="gv-badge">{section.files.length}</span>
      </button>
      <div class="gv-group-actions">
        {section.key === "conflicts" ? (
          <RowButton
            title="全部标记已解决（暂存）"
            disabled={busy}
            onClick={() => void store.stage(paths)}
          >
            <IconCheck />
          </RowButton>
        ) : null}
        {section.key === "staged" ? (
          <RowButton
            title="全部取消暂存"
            disabled={busy}
            onClick={() => void store.unstage(paths)}
          >
            <IconUnstage />
          </RowButton>
        ) : null}
        {section.key === "changes" ? (
          <>
            <RowButton title="全部暂存" disabled={busy} onClick={() => void store.stage(paths)}>
              <IconStage />
            </RowButton>
            {changed.length === 0 ? null : (
              <RowButton
                title={`丢弃 ${changed.length} 个文件的改动`}
                danger
                disabled={busy}
                onClick={() =>
                  store.requestDiscard(changed, "worktree", `丢弃 ${changed.length} 个文件的改动？`)
                }
              >
                <IconDiscard />
              </RowButton>
            )}
            {untracked.length === 0 ? null : (
              <RowButton
                title={`删除 ${untracked.length} 个未跟踪文件`}
                danger
                disabled={busy}
                onClick={() =>
                  store.requestDiscard(untracked, "untracked", `删除 ${untracked.length} 个未跟踪文件？`)
                }
              >
                <IconTrash />
              </RowButton>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

/** One side of one changed file: status letter, path, that side's counts, actions. */
function FileRow({
  store,
  section,
  file,
  active,
}: {
  store: GitStore;
  section: Section;
  file: GitFile;
  active: boolean;
}): JSX.Element {
  const side = section.side;
  const untracked = file.untracked;
  const { dir, name } = pathParts(file.path);
  const origName = file.origPath === null ? null : pathParts(file.origPath).name;
  const stats = side === "index" ? file.indexStats : side === "worktree" ? file.worktreeStats : null;
  const letter =
    section.key === "conflicts" ? "!" : section.key === "staged" ? file.index : untracked ? "?" : file.worktree;
  const open = (): void => {
    if (side !== null) store.selectFile(file, side);
  };
  const path = file.origPath === null ? file.path : `${file.origPath} → ${file.path}`;

  return (
    <div
      class={`gv-file${active ? " active" : ""}${side === null ? " static" : ""}${section.key === "conflicts" ? " conflict" : ""}`}
      role={side === null ? undefined : "button"}
      tabIndex={side === null ? undefined : 0}
      title={path}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        open();
      }}
    >
      <span class="gv-code">{letter}</span>
      <span class="gv-path">
        {origName === null ? null : <span class="gv-renamed">{origName} → </span>}
        <span class="gv-dir">{dir}</span>
        {name}
      </span>
      <LineStats stats={stats} />
      <span class="gv-row-actions">
        {side === null ? (
          <RowButton
            title="标记已解决（暂存）"
            disabled={store.busy}
            onClick={() => void store.stage([file.path])}
          >
            <IconCheck />
          </RowButton>
        ) : null}
        {side === "worktree" ? (
          <RowButton
            title={untracked ? "跟踪文件" : "暂存"}
            disabled={store.busy}
            onClick={() => void store.stage([file.path])}
          >
            <IconStage />
          </RowButton>
        ) : null}
        {side === "index" ? (
          <RowButton title="取消暂存" disabled={store.busy} onClick={() => void store.unstage([file.path])}>
            <IconUnstage />
          </RowButton>
        ) : null}
        {side === null ? null : untracked ? (
          <RowButton
            title="删除文件"
            danger
            disabled={store.busy}
            onClick={() => store.requestDiscard([file.path], "untracked", `删除 ${file.path}？`)}
          >
            <IconTrash />
          </RowButton>
        ) : (
          <RowButton
            title={side === "index" ? "丢弃已暂存改动" : "丢弃改动"}
            danger
            disabled={store.busy}
            onClick={() =>
              store.requestDiscard(
                [file.path],
                side === "index" ? "all" : "worktree",
                `丢弃 ${file.path} 的改动？`,
              )
            }
          >
            <IconDiscard />
          </RowButton>
        )}
      </span>
    </div>
  );
}