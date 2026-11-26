// Sidebar (常驻固定 260px): three-section redesign — search + new session on
// top, pinned strip + per-cwd session-group cards in the middle, a settings
// popover entry at the bottom. Keeps every former capability (switch, rename,
// clone, export, delete, auto-compaction / steering / follow-up settings) and
// adds session search and pinning (bridge_toggle_pin). Switching a session
// rehydrates the message stream and reloads the list in place.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import type { Command, RpcConnection } from "./rpc-connection";
import type { SessionStore } from "./session-store";
import type { ResponseRecord } from "./protocol";
import { IconChevron, IconGear, IconStar } from "./icons";
import { Collapse } from "./collapse";

export type SessionSummary = {
  path: string;
  name: string | null;
  preview: string | null;
  mtime: number;
  pinned?: boolean;
};

/** One per-working-directory group with its recent sessions (bridge). */
export type SessionGroup = {
  name: string;
  cwd: string | null;
  mtime: number;
  current: boolean;
  sessions: SessionSummary[];
};

function formatMtime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Group label for groups without a cwd: the decoded directory name. */
function groupLabel(g: SessionGroup): string {
  const decoded = g.name.replace(/^--/, "").replace(/--$/, "");
  return decoded || g.name;
}

/** Path segments of a cwd, both separators, drive prefix kept (`D:`). */
function pathSegments(cwd: string): string[] {
  return cwd.split(/[\\/]+/).filter(Boolean);
}

/**
 * Short label per group cwd: the last segment (`H5-study`). Groups whose last
 * segments collide grow one parent at a time (`harmony/H5-study`) until each
 * label is unique, so equal-named directories stay distinguishable.
 */
function cwdLabels(groups: SessionGroup[]): Map<string, string> {
  const entries: { name: string; cwd: string; segs: string[]; depth: number }[] = [];
  for (const g of groups) {
    if (g.cwd) entries.push({ name: g.name, cwd: g.cwd, segs: pathSegments(g.cwd), depth: 1 });
  }
  const labelOf = (e: (typeof entries)[number]): string =>
    e.segs.length > 0 ? e.segs.slice(-e.depth).join("/") : e.cwd;
  // Bounded by the deepest path; each pass only grows colliding entries.
  for (let pass = 0; pass < 12; pass++) {
    const byLabel = new Map<string, (typeof entries)[number][]>();
    for (const e of entries) {
      const label = labelOf(e);
      const list = byLabel.get(label);
      if (list) list.push(e);
      else byLabel.set(label, [e]);
    }
    let grown = false;
    for (const list of byLabel.values()) {
      if (list.length < 2) continue;
      for (const e of list) {
        if (e.depth < e.segs.length) {
          e.depth += 1;
          grown = true;
        }
      }
    }
    if (!grown) break;
  }
  const labels = new Map<string, string>();
  for (const e of entries) labels.set(e.name, labelOf(e));
  return labels;
}

function sessionLabel(s: SessionSummary): string {
  return s.name ?? s.preview ?? s.path.split(/[\\/]/).pop() ?? s.path;
}

export function Sidebar({
  conn,
  store,
  piCwd,
  readOnly,
  onSwitched,
  onToast,
}: {
  conn: RpcConnection;
  store: SessionStore;
  /** Current pi working directory (from lifecycle); dialog default. */
  piCwd: string | null;
  /** Another tab took over: writes are rejected, so do not offer them. */
  readOnly: boolean;
  onSwitched: () => void;
  onToast?: (text: string, err?: boolean) => void;
}): JSX.Element {
  const [groups, setGroups] = useState<SessionGroup[] | null>(null);
  const [query, setQuery] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  // New-session dialog: dropdown selection ("" = current pi cwd) plus an
  // optional manual path that takes precedence when non-empty.
  const [showNew, setShowNew] = useState(false);
  const [selectedDir, setSelectedDir] = useState("");
  const [newDirInput, setNewDirInput] = useState("");
  // The native folder dialog blocks until the user decides; browse waits.
  const [picking, setPicking] = useState(false);
  // Collapsed group-card directories. First load expands the current
  // session's group and every newer group above it; older groups below stay
  // collapsed. Not persisted: a refresh returns to the default split.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const collapseInitRef = useRef(false);
  const [busy, setBusy] = useState(false);
  // Session files whose runtime is mid-run in the background (bridge notice).
  const [runningPaths, setRunningPaths] = useState<Set<string>>(new Set());
  // Inline rename targets a session file path; menu holds the right-click item.
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; session: SessionSummary; confirm: boolean } | null>(
    null,
  );

  // The sidebar persists across session switches, so the list is reloaded in
  // place after switch/new/clone (the modal used to remount). Commands reject
  // while the WS is down, so a mid-load disconnect keeps the current UI and
  // the next "open" re-triggers the load.
  const load = async (): Promise<void> => {
    try {
      const res = await conn.command({ type: "bridge_list_all_sessions" } as Command);
      if (res.success) {
        const list = (res.data as { groups: SessionGroup[] }).groups;
        setGroups(list);
        if (!collapseInitRef.current) {
          collapseInitRef.current = true;
          // Default split: the current group and everything above it (newer
          // activity) starts expanded; groups below start collapsed.
          const currentIdx = list.findIndex(
            (g) => g.current || g.sessions.some((s) => s.path === store.state.sessionFile),
          );
          const next = new Set<string>();
          if (currentIdx >= 0) {
            for (let i = currentIdx + 1; i < list.length; i++) {
              const g = list[i];
              if (g) next.add(g.name);
            }
          }
          setCollapsed(next);
        }
      } else {
        setGroups([]);
      }
    } catch {
      // Not connected (yet/anymore); retry on the next open state.
    }
  };

  // The sidebar mounts before the WS opens (it is always rendered), so wait
  // for the open transition instead of firing commands into a closed socket.
  useEffect(() => {
    if (conn.state === "open") {
      void load();
      return;
    }
    return conn.onState((state) => {
      if (state === "open") void load();
    });
  }, [conn]);

  // Session files appear lazily (pi writes them on the first message), so the
  // list right after a create is stale. The bridge watches the sessions root
  // and broadcasts this notice when anything on disk changes. The runtimes
  // notice marks sessions whose background runtime is running.
  useEffect(
    () =>
      conn.onRecord((record) => {
        if (record.type !== "bridge_notice") return;
        const notice = (record as { notice?: string }).notice;
        if (notice === "sessions_dirty") {
          void load();
          return;
        }
        if (notice === "runtimes") {
          const runtimes = (record as { runtimes?: { sessionPath: string | null; running: boolean }[] })
            .runtimes;
          setRunningPaths(
            new Set(
              (runtimes ?? [])
                .filter((r) => r.running && r.sessionPath)
                .map((r) => r.sessionPath as string),
            ),
          );
        }
      }),
    [conn],
  );

  // A read-only tab (a newer one took over) must not send writes: the bridge
  // rejects them, so this fails earlier with a reason and keeps the UI in step
  // with what will be accepted.
  const write = (command: Command): Promise<ResponseRecord> => {
    if (readOnly) {
      onToast?.("本页只读，已被新标签页接管", true);
      return Promise.resolve({ type: "response", command: command.type, success: false, error: "本页只读" });
    }
    return conn.command(command);
  };

  const current = store.state.sessionFile;

  // The group actually holding the current session. The bridge's `current`
  // flag tracks the pi process cwd and goes stale after a cross-directory
  // switch (no restart happens), so derive it from the session path.
  const activeGroup = useMemo(
    () => (groups ?? []).find((g) => g.sessions.some((s) => s.path === current)) ?? null,
    [groups, current],
  );
  const activeDir = activeGroup?.cwd ?? piCwd;

  // Search filters sessions by name/preview/path; empty query = everything.
  const filtered = useMemo((): SessionGroup[] => {
    if (groups === null) return [];
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map((g) => ({
        ...g,
        sessions: g.sessions.filter((s) =>
          [s.name, s.preview, s.path].some((v) => v?.toLowerCase().includes(q)),
        ),
      }))
      .filter((g) => g.sessions.length > 0);
  }, [groups, query]);

  // Pinned sessions across all groups, newest first; search applies too.
  const pinned = useMemo(
    () =>
      filtered
        .flatMap((g) => g.sessions)
        .filter((s) => s.pinned)
        .sort((a, b) => b.mtime - a.mtime),
    [filtered],
  );

  const toggleGroup = (name: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  // Group headers show the deepest path segment only (full cwd in the title).
  const labels = useMemo(() => cwdLabels(groups ?? []), [groups]);

  // Known working directories for the new-session dropdown: every group's
  // real cwd, in list order (newest activity first), deduplicated.
  const knownDirs = useMemo((): string[] => {
    const seen = new Set<string>();
    const dirs: string[] = [];
    for (const g of groups ?? []) {
      if (g.cwd && !seen.has(g.cwd)) {
        seen.add(g.cwd);
        dirs.push(g.cwd);
      }
    }
    return dirs;
  }, [groups]);

  const openNewDialog = (): void => {
    setSelectedDir("");
    setNewDirInput("");
    setShowSettings(false);
    setShowNew(true);
  };

  // Native folder dialog via the bridge; the picked path lands in the manual
  // input for the user to confirm before creating.
  const browseDir = async (): Promise<void> => {
    setPicking(true);
    try {
      const res = await conn.command({ type: "bridge_pick_dir" } as Command);
      if (res.success) {
        const path = (res.data as { path?: string | null } | undefined)?.path;
        if (path) setNewDirInput(path);
      } else {
        onToast?.(res.error ?? "打开目录选择器失败", true);
      }
    } catch {
      onToast?.("打开目录选择器失败", true);
    } finally {
      setPicking(false);
    }
  };

  // Create in the directory chosen by the dialog (manual input wins over
  // the dropdown); closes the dialog only on success. An empty selection
  // means the attached runtime's current directory.
  const createSession = async (): Promise<void> => {
    if (await newSession(newDirInput.trim() || selectedDir || undefined)) setShowNew(false);
  };

  const togglePin = async (session: SessionSummary): Promise<void> => {
    setMenu(null);
    const res = await write({ type: "bridge_toggle_pin", path: session.path } as Command);
    if (res.success) {
      const nowPinned = (res.data as { pinned?: boolean } | undefined)?.pinned;
      onToast?.(nowPinned ? "已置顶" : "已取消置顶");
      void load();
    } else {
      onToast?.(res.error ?? "置顶失败", true);
    }
  };

  // Switching attaches the bridge to that session's own pi runtime instead of
  // replacing the session of a shared one: a run in the session being left
  // keeps going (pi's switch_session would abort it, see
  // agent-session-runtime.ts teardownCurrent).
  const switchTo = async (path: string): Promise<boolean> => {
    setBusy(true);
    const res = await write({ type: "bridge_attach", sessionPath: path } as Command);
    setBusy(false);
    if (res.success) {
      onSwitched();
      void load();
      return true;
    }
    onToast?.(res.error ?? "切换会话失败", true);
    return false;
  };

  // A new session gets a fresh runtime in cwd (default: the current one), so
  // nothing running is aborted either.
  const newSession = async (cwd?: string): Promise<boolean> => {
    setBusy(true);
    const res = await write({
      type: "bridge_new_session",
      ...(cwd ? { cwd } : {}),
    } as Command);
    setBusy(false);
    if (res.success) {
      onSwitched();
      void load();
      return true;
    }
    onToast?.(res.error ?? "新建会话失败", true);
    return false;
  };

  const cloneSession = async (): Promise<void> => {
    setBusy(true);
    const res = (await write({ type: "clone" })) as ResponseRecord;
    setBusy(false);
    if (res.success) {
      const data = res.data as { cancelled?: boolean } | undefined;
      if (data?.cancelled) onToast?.("克隆被扩展取消", true);
      else {
        onSwitched();
        void load();
      }
    } else {
      onToast?.(res.error ?? "克隆失败", true);
    }
  };

  const exportHtml = async (): Promise<void> => {
    const res = (await conn.command({ type: "export_html" })) as ResponseRecord;
    if (res.success) {
      const url = (res.data as { url?: string } | undefined)?.url;
      if (url) window.open(url, "_blank", "noopener");
      else onToast?.("导出结果缺少 URL", true);
    } else {
      onToast?.(res.error ?? "导出失败", true);
    }
  };

  const commitRename = async (): Promise<void> => {
    const name = renameValue.trim();
    setRenaming(null);
    const res = await write({ type: "set_session_name", name });
    if (res.success) {
      store.setState({ sessionName: name || null });
      void load();
    } else {
      onToast?.(res.error ?? "重命名失败", true);
    }
  };

  const openMenu = (e: MouseEvent, session: SessionSummary): void => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({
      x: Math.min(e.clientX, window.innerWidth - 160),
      y: Math.min(e.clientY, window.innerHeight - 200),
      session,
      confirm: false,
    });
  };

  // Any click outside the menu (or Esc) closes it; openMenu's stopPropagation
  // keeps the opening event from immediately closing it.
  useEffect(() => {
    if (!menu) return;
    const close = (): void => setMenu(null);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  // Settings popover closes on outside click / Esc, same pattern as the menu.
  useEffect(() => {
    if (!showSettings && !showNew) return;
    const close = (): void => {
      setShowSettings(false);
      setShowNew(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [showSettings, showNew]);

  // set_session_name acts on the current session, so renaming/cloning/exporting
  // another entry switches to it first.
  const startRename = async (session: SessionSummary): Promise<void> => {
    setMenu(null);
    if (session.path !== current && !(await switchTo(session.path))) return;
    const base = session.path === current ? (store.state.sessionName ?? session.name ?? "") : (session.name ?? "");
    setRenameValue(base);
    setRenaming(session.path);
  };

  const runOnSession = async (session: SessionSummary, action: () => Promise<void>): Promise<void> => {
    setMenu(null);
    if (session.path !== current && !(await switchTo(session.path))) return;
    await action();
  };

  const copyPath = async (session: SessionSummary): Promise<void> => {
    setMenu(null);
    try {
      await navigator.clipboard.writeText(session.path);
      onToast?.("已复制会话路径");
    } catch {
      onToast?.("复制失败", true);
    }
  };

  // Windows cannot delete a file pi holds open, so deleting the current
  // session switches away first (to the newest other session, or a fresh
  // session when none exists) before the file goes to the recycle bin.
  const deleteSession = async (session: SessionSummary): Promise<void> => {
    setMenu(null);
    setBusy(true);
    if (session.path === current) {
      const others = (groups ?? [])
        .flatMap((g) => g.sessions)
        .filter((s) => s.path !== session.path)
        .sort((a, b) => b.mtime - a.mtime);
      const target = others[0];
      const switched = target ? await switchTo(target.path) : await newSession();
      if (!switched) {
        setBusy(false);
        onToast?.("无法切换会话，已取消删除", true);
        return;
      }
    }
    const res = await write({ type: "bridge_delete_session", path: session.path } as Command);
    setBusy(false);
    if (res.success) {
      onToast?.("已移入回收站");
      void load();
    } else {
      onToast?.(res.error ?? "删除失败", true);
    }
  };

  const setAutoCompaction = async (enabled: boolean): Promise<void> => {
    const res = await write({ type: "set_auto_compaction", enabled });
    if (res.success) store.setState({ autoCompactionEnabled: enabled });
    else onToast?.(res.error ?? "设置失败", true);
  };

  const setSteeringMode = async (mode: string): Promise<void> => {
    const res = await write({ type: "set_steering_mode", mode });
    if (res.success) store.setState({ steeringMode: mode });
    else onToast?.(res.error ?? "设置失败", true);
  };

  const setFollowUpMode = async (mode: string): Promise<void> => {
    const res = await write({ type: "set_follow_up_mode", mode });
    if (res.success) store.setState({ followUpMode: mode });
    else onToast?.(res.error ?? "设置失败", true);
  };

  const sessionRow = (s: SessionSummary): JSX.Element =>
    renaming === s.path ? (
      <input
        key={s.path}
        class="panel-rename-input"
        value={renameValue}
        placeholder="名称，留空清除"
        autoFocus
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Enter") void commitRename();
          if (e.key === "Escape") setRenaming(null);
        }}
        onInput={(e) => setRenameValue((e.target as HTMLInputElement).value)}
      />
    ) : (
      <div
        key={s.path}
        class={`session-card${s.path === current ? " current" : ""}`}
        onClick={() => {
          if (!busy) void switchTo(s.path);
        }}
        onContextMenu={(e) => openMenu(e, s)}
      >
        <div class="session-card-top">
          <span class="session-card-name">{sessionLabel(s)}</span>
          {runningPaths.has(s.path) ? (
            <span class="session-run-badge" title="运行中（后台继续运行）">
              <span class="spinner" />
            </span>
          ) : null}
          {s.pinned ? <span class="session-pin-badge" title="已置顶"><IconStar size={11} /></span> : null}
        </div>
        <div class="session-card-bottom">
          <span class="session-meta">{formatMtime(s.mtime)}</span>
          <span
            class="session-more"
            title="更多操作"
            onClick={(e) => openMenu(e, s)}
            onContextMenu={(e) => openMenu(e, s)}
          >
            ⋯
          </span>
        </div>
      </div>
    );

  return (
    <div class="sidebar">
      <div class="sidebar-top">
        <input
          class="sidebar-search"
          type="search"
          placeholder="搜索会话…"
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
        />
        <button
          class="sidebar-new-btn"
          disabled={busy}
          title="新建会话（可选择工作目录）"
          onClick={(e) => {
            e.stopPropagation();
            setShowNew(!showNew);
            if (!showNew) openNewDialog();
          }}
        >
          ＋ 新建会话
        </button>
        {showNew ? (
          <div class="new-pop" onClick={(e) => e.stopPropagation()}>
            <div class="new-pop-title">工作目录</div>
            <select
              class="new-pop-select"
              value={selectedDir}
              onChange={(e) => setSelectedDir((e.target as HTMLSelectElement).value)}
            >
              <option value="">{activeDir ? `当前目录：${activeDir}` : "当前目录"}</option>
              {knownDirs
                .filter((d) => d !== activeDir)
                .map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
            </select>
            <div class="new-pop-row">
              <input
                class="new-pop-input"
                type="text"
                placeholder="或输入其他目录的绝对路径（可选）"
                value={newDirInput}
                onInput={(e) => setNewDirInput((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void createSession();
                }}
              />
              <button class="new-pop-browse" disabled={picking} onClick={() => void browseDir()}>
                {picking ? "选择中…" : "浏览…"}
              </button>
            </div>
            <button class="new-pop-create" disabled={busy} onClick={() => void createSession()}>
              创建会话
            </button>
          </div>
        ) : null}
      </div>
      <div class="panel-list">
        {groups === null ? (
          <div class="panel-empty">加载中…</div>
        ) : filtered.length === 0 ? (
          <div class="panel-empty">{query ? "无匹配会话" : "暂无历史会话"}</div>
        ) : (
          <>
            {pinned.length > 0 ? (
              <div class="pinned-block">
                <div class="pinned-label">置顶</div>
                {pinned.map(sessionRow)}
              </div>
            ) : null}
            {filtered.map((g) => {
              // While searching, every match must be visible: expand all.
              const isCollapsed = query.trim() === "" && collapsed.has(g.name);
              return (
                <div key={g.name} class="group-card">
                  <div class="group-card-head-row">
                    <button
                      class={`group-card-head${activeGroup ? (g.name === activeGroup.name ? " current" : "") : g.current ? " current" : ""}${isCollapsed ? " collapsed" : ""}`}
                      title={g.cwd ?? g.name}
                      onClick={() => toggleGroup(g.name)}
                    >
                      <span class="caret">
                        <IconChevron />
                      </span>
                      <span class="group-card-cwd">{labels.get(g.name) ?? groupLabel(g)}</span>
                      <span class="group-count">{g.sessions.length}</span>
                    </button>
                    <button
                      class="group-card-add"
                      title={g.cwd ? `在 ${g.cwd} 创建新会话` : "该分组没有工作目录信息"}
                      disabled={busy || !g.cwd}
                      onClick={() => void newSession(g.cwd ?? undefined)}
                    >
                      +
                    </button>
                  </div>
                  <Collapse open={!isCollapsed}>
                    <div class="group-card-body">{g.sessions.map(sessionRow)}</div>
                  </Collapse>
                </div>
              );
            })}
          </>
        )}
      </div>
      <div class="sidebar-bottom">
        <button
          class="sidebar-settings-btn"
          title="运行设置"
          onClick={(e) => {
            e.stopPropagation();
            setShowSettings(!showSettings);
          }}
        >
          <IconGear size={13} /> 运行设置
        </button>
        {showSettings ? (
          <div class="settings-pop" onClick={(e) => e.stopPropagation()}>
            <label class="setting-row">
              <input
                type="checkbox"
                checked={store.state.autoCompactionEnabled === true}
                onChange={(e) => void setAutoCompaction((e.target as HTMLInputElement).checked)}
              />
              自动压缩上下文
            </label>
            {store.state.steeringMode ? (
              <label class="setting-row">
                插话模式
                <select
                  value={store.state.steeringMode}
                  onChange={(e) => void setSteeringMode((e.target as HTMLSelectElement).value)}
                >
                  <option value="all">全部</option>
                  <option value="one-at-a-time">逐条</option>
                </select>
              </label>
            ) : null}
            {store.state.followUpMode ? (
              <label class="setting-row">
                随后模式
                <select
                  value={store.state.followUpMode}
                  onChange={(e) => void setFollowUpMode((e.target as HTMLSelectElement).value)}
                >
                  <option value="one-at-a-time">逐条</option>
                  <option value="all">全部</option>
                </select>
              </label>
            ) : null}
          </div>
        ) : null}
      </div>
      {menu ? (
        <div
          class="session-menu"
          style={{ left: `${menu.x}px`, top: `${menu.y}px` }}
          onClick={(e) => e.stopPropagation()}
        >
          <button class="session-menu-item" onClick={() => void startRename(menu.session)}>
            重命名
          </button>
          <button class="session-menu-item" onClick={() => void togglePin(menu.session)}>
            {menu.session.pinned ? "取消置顶" : "置顶"}
          </button>
          <button class="session-menu-item" onClick={() => void copyPath(menu.session)}>
            复制路径
          </button>
          <button class="session-menu-item" onClick={() => void runOnSession(menu.session, cloneSession)}>
            克隆
          </button>
          <button class="session-menu-item" onClick={() => void runOnSession(menu.session, exportHtml)}>
            导出 HTML
          </button>
          {menu.confirm ? (
            <button class="session-menu-item danger" onClick={() => void deleteSession(menu.session)}>
              确认删除？
            </button>
          ) : (
            <button class="session-menu-item danger" onClick={() => setMenu({ ...menu, confirm: true })}>
              删除
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
