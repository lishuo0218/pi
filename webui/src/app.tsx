// Root app (M3): M1/M2 features plus session panel (F-20/F-21), fork
// (F-21), slash command autocomplete (F-22), extension UI mapping (F-23),
// bash panel (F-24), Git drawer, compaction + context usage (F-25), retry
// banner (F-26), full-screen Git view (F-29). The composer is a rich draft:
// paths dragged out of the file tree land in it as chips.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { useSyncExternalStore } from "preact/compat";
import { Fragment, type JSX } from "preact";
import { RpcConnection, type ConnState } from "./rpc-connection";
import { SessionStore, type StreamRow } from "./session-store";
import { ToolStore } from "./tool-store";
import { TodoStore } from "./todo-store";
import { bindRecords, type Disposition, type RetryInfo, type RunPhase } from "./record-binder";
import { MessageView, textOf } from "./messages";
import { turnPreview } from "./turn-preview";
import { ExtensionDialog, StatusChips, WidgetArea } from "./extension-ui";
import { Sidebar } from "./sidebar";
import { RightPanel } from "./right-panel";
import { getPreviewWidth, onPreviewWidthChange } from "./panel-width";
import { getSidebarWidth, onSidebarWidthChange } from "./sidebar-width";
import { closePreview, getPreviewRequest, onPreviewChange } from "./preview-target";
import { Logo } from "./logo";
import { IconArrowUp, IconGit, IconImage, IconMenu, IconMoon, IconStop, IconSun, IconColumns } from "./icons";
import { GitView } from "./git/git-view";
import { sessionFiles } from "./session-files";
import { droppedMessages } from "./session-history";
import { duplicateBashRows, renderedRows } from "./stream-rows";
import { groupActivities } from "./activity-groups";
import { ActivityGroup } from "./activity-group";
import { TurnFilesCard } from "./turn-files-card";
import { ModelDeleteDialog, ModelEditor } from "./model-editor";
import { getPiCwd } from "./pi-cwd";
import { carriesPath, PATH_DRAG_TYPE } from "./path-drag";
import {
  chipPaths,
  clearDraft,
  draftText,
  insertDraftChip,
  insertDraftText,
  setDraftText,
} from "./rich-draft";
import { rememberSentChips } from "./user-chips";
import { ModelPicker } from "./model-picker";
import { setPiCwd as reportPiCwd } from "./pi-cwd";
import { initTheme, toggleTheme, watchSystemTheme, type Theme } from "./theme";
import { DEFAULT_KEYBINDINGS, matchesKey } from "./keybindings";
import type {
  AgentMessage,
  AssistantMessage,
  CommandInfo,
  ExtensionUiDialog,
  ExtensionUiResponse,
  Model,
  ModelDraft,
  ModelEntry,
  ModelsConfigSnapshot,
  SessionEntryRecord,
  ToolResultMessage,
  UserMessage,
} from "./protocol";

const store = new SessionStore();
const tools = new ToolStore();
const todo = new TodoStore();
const conn = new RpcConnection();

type ThinkingLevels = { levels: string[] } | null;
type ContextUsage = { tokens: number; contextWindow: number; percent: number } | null;

type Attachment = { id: number; data: string; mimeType: string; previewUrl: string };
let attachSeq = 0;

/** A dialog belongs to the session attached when it arrived (see respondUi). */
type QueuedDialog = ExtensionUiDialog & { sessionFile: string | null };

/** Files a tool call that no user row can place (pre-compaction history). */
const ORPHAN_TURN = { index: 0, timestamp: 0, preview: "" };

/** Tool-call args of a message list, by toolCallId (toolResults carry none). */
function callArgsOf(messages: AgentMessage[]): Map<string, Record<string, unknown>> {
  const callArgs = new Map<string, Record<string, unknown>>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of (message as AssistantMessage).content ?? []) {
      if (block.type !== "toolCall") continue;
      const args = block.arguments;
      if (args && typeof args === "object" && !Array.isArray(args)) {
        callArgs.set(block.id, args as Record<string, unknown>);
      }
    }
  }
  return callArgs;
}

/**
 * Apply a get_messages snapshot to the stores: turn grouping (the same count as
 * the live binder, so file cards keep their turn), tool cards from the
 * toolResult messages plus the assistant call args, the checklist, and the
 * rows. Leaves the live queue untouched; rehydration re-applies it.
 */
function applyMessages(messages: AgentMessage[]): void {
  tools.beginHydrate();
  const callArgs = callArgsOf(messages);
  for (const message of messages) {
    if (message.role === "user") {
      const user = message as UserMessage;
      tools.beginTurn(user.timestamp, turnPreview(user.content));
    } else if (message.role === "toolResult") {
      const result = message as ToolResultMessage;
      tools.addFromToolResult(result, callArgs.get(result.toolCallId) ?? {});
      if (result.toolName === "todo") {
        todo.setFromDetails((result as unknown as { details?: Record<string, unknown> }).details);
      }
    }
  }
  store.hydrate(messages, store.state);
}

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const token = new URLSearchParams(location.search).get("token");
  const query = token ? `?token=${encodeURIComponent(token)}` : "";
  return `${proto}//${location.host}/ws${query}`;
}

export function App(): JSX.Element {
  const version = useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.version,
  );
  const toolVersion = useSyncExternalStore(
    (cb) => tools.subscribe(cb),
    () => tools.version,
  );
  const [connState, setConnState] = useState<ConnState>("connecting");
  const [runPhase, setRunPhase] = useState<RunPhase>("idle");
  const [models, setModels] = useState<Model[]>([]);
  // Models the user added in models.json (bridge snapshot), for the picker's
  // edit/delete rows; null until the bridge answered.
  const [customModels, setCustomModels] = useState<ModelsConfigSnapshot | null>(null);
  /** Open add/edit form; null keeps it closed. */
  const [modelEditor, setModelEditor] = useState<{ entry: ModelEntry | null } | null>(null);
  const [modelToDelete, setModelToDelete] = useState<ModelEntry | null>(null);
  const [thinkingLevels, setThinkingLevels] = useState<ThinkingLevels>(null);
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [toasts, setToasts] = useState<{ id: number; text: string; err: boolean }[]>([]);
  // pi can hold several dialogs pending at once (each extension_ui_request
  // has its own id on the agent side), so they queue FIFO: answering the
  // front one reveals the next instead of dropping earlier requests.
  const [dialogQueue, setDialogQueue] = useState<QueuedDialog[]>([]);
  const dialog = dialogQueue[0] ?? null;
  const [statuses, setStatuses] = useState(new Map<string, string>());
  const [widgets, setWidgets] = useState(new Map<string, { lines: string[]; placement: string }>());
  const [retry, setRetry] = useState<RetryInfo | null>(null);
  const [contextUsage, setContextUsage] = useState<ContextUsage>(null);
  const [sessionTotals, setSessionTotals] = useState<{ input: number; output: number; cost: number } | null>(null);
  const [showGit, setShowGit] = useState(false);
  const [todoOpen, setTodoOpen] = useState(true);
  // The panel's file preview is opened from leaf components (file tree, tool
  // cards) through preview-target.ts, so the root only subscribes to it.
  const [preview, setPreview] = useState(getPreviewRequest);
  useEffect(() => onPreviewChange(() => setPreview(getPreviewRequest())), []);
  const [previewWidth, setPreviewWidth] = useState(getPreviewWidth);
  useEffect(() => onPreviewWidthChange(() => setPreviewWidth(getPreviewWidth())), []);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(getSidebarWidth);
  useEffect(() => onSidebarWidthChange(() => setSidebarWidth(getSidebarWidth())), []);
  const [injected, setInjected] = useState<{ v: number; text: string } | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [piExited, setPiExited] = useState<{ code: number | null; signal: string | null } | null>(null);
  const [piCwd, setPiCwd] = useState<string | null>(null);
  const [piError, setPiError] = useState<string | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [theme, setTheme] = useState<Theme>(initTheme);
  const injectSeq = useRef(0);
  const toastSeq = useRef(0);
  /** Bumped by every record that finalizes streamed content (see rehydrate). */
  const streamEndSeq = useRef(0);
  /** Generation of the running rehydrate; older snapshots are discarded. */
  const rehydrateSeq = useRef(0);

  // The stream/composer/banners shift left by this var when the sidebar shows.
  useLayoutEffect(() => {
    document.documentElement.style.setProperty("--sidebar-w", sidebarOpen ? `${sidebarWidth}px` : "0px");
  }, [sidebarOpen, sidebarWidth]);

  // The Git panel is a column, not an overlay: the stream gives up its width so
  // the conversation stays readable beside the commit box, files and history.
  useLayoutEffect(() => {
    document.documentElement.style.setProperty("--git-w", showGit ? "380px" : "0px");
  }, [showGit]);

  // The right panel occupies a strip on the right edge: the ToDo and file tree
  // view at a fixed width, a file preview at its dragged width.
  const panelOpen = todoOpen || preview !== null;
  useLayoutEffect(() => {
    const width = preview === null ? 300 : previewWidth;
    document.documentElement.style.setProperty("--todo-w", panelOpen ? `${width}px` : "0px");
  }, [panelOpen, preview, previewWidth]);

  const pushToast = (text: string, err = false): void => {
    const id = ++toastSeq.current;
    setToasts((ts) => [...ts, { id, text, err }]);
    if (!err) setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 2500);
  };

  const refreshStats = async (): Promise<void> => {
    const res = await conn.command({ type: "get_session_stats" });
    if (res.success) {
      const data = res.data as {
        tokens?: { input?: number; output?: number };
        cost?: number;
        contextUsage?: ContextUsage;
      };
      setContextUsage(data.contextUsage ?? null);
      // Full-session totals per F-17: includes tool nested usage and
      // compaction/summary generation, matching the TUI footer.
      if (data.tokens) {
        setSessionTotals({
          input: data.tokens.input ?? 0,
          output: data.tokens.output ?? 0,
          cost: data.cost ?? 0,
        });
      }
    }
  };

  /** Models the user added in models.json, for the picker's edit/delete rows. */
  const loadModelsConfig = async (): Promise<void> => {
    const res = await conn.command({ type: "bridge_models_config" });
    if (res.success) setCustomModels(res.data as ModelsConfigSnapshot);
  };

  /**
   * Pi reads models.json only at startup, so a saved model shows up after the
   * bridge restarts it. Commands fail while the new process boots; retry
   * instead of reporting "not running" during that window.
   */
  const reloadModels = async (): Promise<boolean> => {
    for (let attempt = 0; attempt < 60; attempt++) {
      const res = await conn.command({ type: "get_available_models" });
      if (res.success) {
        setModels((res.data as { models: Model[] }).models);
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  };

  const saveModelDraft = async (draft: ModelDraft): Promise<string | null> => {
    const res = await conn.command({ type: "bridge_save_model", draft });
    if (!res.success) return res.error ?? "保存失败";
    setModelEditor(null);
    pushToast("已保存模型");
    void loadModelsConfig();
    void reloadModels().then((ok) => {
      if (!ok) pushToast("重启后未能读取模型列表，请稍后刷新页面", true);
    });
    return null;
  };

  const deleteCustomModel = async (entry: ModelEntry): Promise<void> => {
    setModelToDelete(null);
    const res = await conn.command({ type: "bridge_delete_model", provider: entry.provider, modelId: entry.id });
    if (!res.success) {
      pushToast(res.error ?? "删除失败", true);
      return;
    }
    pushToast("已删除模型");
    void loadModelsConfig();
    void reloadModels();
  };

  // Full rehydration after session switch / fork / reconnect (F-01 again).
  // `resetUi` drops extension dialogs, status chips, widgets and the retry
  // banner: they belong to the session being left. A compaction rehydrate
  // keeps them, since its dialog is still pending in the same session.
  const rehydrate = async (options?: { resetUi?: boolean }): Promise<void> => {
    const gen = ++rehydrateSeq.current;
    if (options?.resetUi) {
      setDialogQueue([]);
      setStatuses(new Map());
      setWidgets(new Map());
      setRetry(null);
    }
    // Only the per-turn derivation is stale; the live queue is not part of the
    // snapshot and must survive a compaction rehydrate.
    tools.beginHydrate();
    todo.clear();
    // A message that finishes while the snapshot is in flight makes it stale:
    // the bridge stops replaying at message_end, so neither the snapshot nor
    // the replay carries it. Detect that and ask once more (see below).
    const endsBefore = streamEndSeq.current;
    const [stateRes, messagesRes] = await Promise.all([
      conn.command({ type: "get_state" }),
      conn.command({ type: "get_messages" }),
    ]);
    // A newer rehydrate started (rapid session switching): its snapshot wins.
    if (gen !== rehydrateSeq.current) return;
    if (!stateRes.success || !messagesRes.success) {
      // Never leave a half-applied snapshot: the sidebar may already point at
      // the new session while the body would still show the old transcript.
      store.reset();
      tools.clear();
      setRunPhase("idle");
      pushToast(stateRes.error ?? messagesRes.error ?? "会话恢复失败", true);
      return;
    }
    const data = stateRes.data as {
      model?: Model;
      thinkingLevel?: string;
      isStreaming?: boolean;
      isCompacting?: boolean;
      pendingMessageCount?: number;
      sessionName?: string;
      sessionFile?: string;
      autoCompactionEnabled?: boolean;
      steeringMode?: string;
      followUpMode?: string;
    };
    store.setState({
      model: data.model ?? null,
      thinkingLevel: data.thinkingLevel ?? null,
      isStreaming: data.isStreaming ?? false,
      sessionName: data.sessionName ?? null,
      sessionFile: data.sessionFile ?? null,
      autoCompactionEnabled: data.autoCompactionEnabled ?? null,
      steeringMode: data.steeringMode ?? null,
      followUpMode: data.followUpMode ?? null,
    });
    // A turn that is already running keeps running across a page reload and
    // across session switches (each session has its own pi runtime): restore
    // the running state so the stop button and status dot come back.
    setRunPhase(data.isStreaming ? "running" : "idle");
    setCompacting(data.isCompacting === true);
    // Steering/follow-up texts are pi-internal; the count is not, so a queued
    // message still shows as queued after a reload (F-01).
    tools.setPendingCount(data.pendingMessageCount ?? null);
    applyMessages((messagesRes.data as { messages: AgentMessage[] }).messages);
    // A session (and possibly cwd) switch invalidates the open preview path.
    closePreview();
    if (streamEndSeq.current !== endsBefore) {
      const again = await conn.command({ type: "get_messages" });
      if (gen !== rehydrateSeq.current) return;
      if (again.success) applyMessages((again.data as { messages: AgentMessage[] }).messages);
    }
    // The snapshot has landed, so ask the bridge for the records of the turn
    // still streaming (page reload / session switch in the middle of a run).
    // They arrive before this response and land in the store applied above.
    await conn.command({ type: "bridge_resume" });
    if (gen !== rehydrateSeq.current) return;
    // Messages before the last compaction are not in get_messages anymore.
    // Keep them ready so "load earlier" can reach past the boundary.
    const entriesRes = await conn.command({ type: "get_entries" });
    if (gen !== rehydrateSeq.current) return;
    if (entriesRes.success) {
      const entries = entriesRes.data as { entries?: SessionEntryRecord[]; leafId?: string | null };
      store.setEarlier(droppedMessages(entries.entries ?? [], entries.leafId ?? null));
    }
    await refreshStats();
  };

  useEffect(() => {
    let everOpened = false;
    const unsubState = conn.onState((state) => {
      setConnState(state);
      // Records broadcast while the socket was down are gone (the bridge drops
      // them for a client that is not there), so a reopened socket re-aligns
      // from get_state/get_messages instead of trusting the local copy.
      if (state === "open") {
        if (everOpened) void rehydrate({ resetUi: true });
        everOpened = true;
      }
    });
    // Content a snapshot can miss: a message that finalizes while get_messages
    // is in flight is in neither the snapshot nor the replay (see rehydrate).
    const unsubStreamEnd = conn.onRecord((record) => {
      if (
        record.type === "message_end" ||
        record.type === "tool_execution_end" ||
        record.type === "agent_settled"
      ) {
        streamEndSeq.current++;
      }
    });
    // M4 lifecycle/notice records (not protocol events, bridge-owned).
    const unsubLifecycle = conn.onRecord((record) => {
      const type = record.type;
      if (type === "pi_exited") {
        const ev = record as { code?: number | null; signal?: string | null };
        setPiExited({ code: ev.code ?? null, signal: ev.signal ?? null });
        setRunPhase("idle");
      } else if (type === "pi_started") {
        setPiError(null);
        // The lifecycle record carries pi's cwd; it changes when a session is
        // created in another directory, so the sidebar dialog can default to it.
        const cwd = (record as { cwd?: string }).cwd;
        if (cwd) {
          setPiCwd(cwd);
          reportPiCwd(cwd);
          closePreview();
        }
        if (piExitedRef.current) {
          pushToast("pi 已重启，正在恢复会话");
          setPiExited(null);
          // The extension dialogs of the dead process can never be answered.
          void rehydrate({ resetUi: true });
        }
        // Protocol-match hint (PRD: 协议回退): piVersion empty = probe failed.
        if ((record as { piVersion?: string }).piVersion === "") {
          pushToast("pi 版本未知，协议可能不匹配", true);
        }
      } else if (type === "pi_error") {
        // Spawn/attach failed bridge-side: without this the UI keeps looking
        // connected while every command answers "pi process is not running".
        const message = (record as { message?: string }).message ?? "未知错误";
        setPiError(message);
        setRunPhase("idle");
        pushToast(`pi 出错：${message}`, true);
      } else if (type === "bridge_notice") {
        if (record.notice === "taken_over") {
          setReadOnly(true);
          pushToast("已在新的标签页接管，本页只读", true);
        }
        if (record.notice === "active") {
          setReadOnly(false);
          pushToast("已接管控制权");
        }
        if (record.notice === "pi_restarting") pushToast("正在重启 pi…");
      }
    });
    const unsubRecords = conn.onRecord(
      bindRecords(store, tools, todo, {
        onDisposition: (d: Disposition) => {
          pushToast(
            d === "started" ? "已开始运行" : d === "queued" ? "已加入队列" : "已交给扩展处理",
          );
        },
        onRunPhase: (phase: RunPhase) => {
          setRunPhase(phase);
          if (phase === "idle") void refreshStats();
        },
        onUiRequest: (record) => {
          const req = record as { method?: string; id?: string };
          const method = req.method ?? "";
          switch (method) {
            case "select":
            case "confirm":
            case "input":
            case "editor": {
              const req = record as ExtensionUiDialog;
              setDialogQueue((q) => {
                // Already queued (e.g. reconnect re-request)? Keep the first.
                if (q.some((d) => d.id === req.id)) return q;
                // Tag it with the session it came from: a reply is only
                // meaningful to the pi runtime attached then.
                return [...q, { ...req, sessionFile: store.state.sessionFile }];
              });
              break;
            }
            case "notify": {
              const n = record as { message?: string; notifyType?: string };
              pushToast(n.message ?? "", n.notifyType === "error" || n.notifyType === "warning");
              break;
            }
            case "setStatus": {
              const s = record as { statusKey?: string; statusText?: string };
              setStatuses((prev) => {
                const next = new Map(prev);
                if (s.statusText) next.set(s.statusKey ?? "", s.statusText);
                else next.delete(s.statusKey ?? "");
                return next;
              });
              break;
            }
            case "setWidget": {
              const w = record as { widgetKey?: string; widgetLines?: string[]; widgetPlacement?: string };
              setWidgets((prev) => {
                const next = new Map(prev);
                if (w.widgetLines) {
                  next.set(w.widgetKey ?? "", { lines: w.widgetLines, placement: w.widgetPlacement ?? "aboveEditor" });
                } else next.delete(w.widgetKey ?? "");
                return next;
              });
              break;
            }
            case "setTitle":
              document.title = (record as { title?: string }).title ?? "Pi Web";
              break;
            case "set_editor_text":
              setInjected({ v: ++injectSeq.current, text: (record as { text?: string }).text ?? "" });
              break;
          }
        },
        onToast: pushToast,
        onRetry: setRetry,
        onCompacting: setCompacting,
        onCompactionEnd: () => {
          void refreshStats();
          void rehydrate();
        },
      }),
    );

    conn.connect(wsUrl());

    const unsubSystemTheme = watchSystemTheme((t) => setTheme(t));

    void (async () => {
      // Wait for open before hydrating; commands fail while connecting.
      await new Promise<void>((resolve) => {
        const check = (): void => {
          if (connStateRef.current === "open") resolve();
          else setTimeout(check, 100);
        };
        check();
      });
      try {
        const [modelsRes, levelsRes, commandsRes, customRes] = await Promise.all([
          conn.command({ type: "get_available_models" }),
          conn.command({ type: "get_available_thinking_levels" }),
          conn.command({ type: "get_commands" }),
          conn.command({ type: "bridge_models_config" }),
        ]);
        if (modelsRes.success) {
          const { models: list } = modelsRes.data as { models: Model[] };
          setModels(list);
        }
        if (customRes.success) setCustomModels(customRes.data as ModelsConfigSnapshot);
        if (levelsRes.success) {
          setThinkingLevels(levelsRes.data as { levels: string[] });
        }
        if (commandsRes.success) {
          const { commands: list } = commandsRes.data as { commands: CommandInfo[] };
          setCommands(list);
        }
        await rehydrate();
      } catch {
        pushToast("会话恢复失败，请刷新重试", true);
      }
    })();

    return () => {
      unsubState();
      unsubStreamEnd();
      unsubLifecycle();
      unsubRecords();
      unsubSystemTheme();
      conn.close();
    };
  }, []);

  // Keep a ref of conn state for the hydration promise above.
  const connStateRef = useRef<ConnState>("connecting");
  connStateRef.current = connState;
  const piExitedRef = useRef(false);
  piExitedRef.current = piExited !== null;

  // Esc aborts a run (M4 keybinding), unless a modal is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (dialog || modelEditor !== null || modelToDelete !== null) return;
      if (runningRef.current && !readOnlyRef.current && matchesKey(e, DEFAULT_KEYBINDINGS.abort)) {
        e.preventDefault();
        setRunPhase("stopping");
        void conn.command({ type: "abort" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialog, modelEditor, modelToDelete]);
  const runningRef = useRef(false);
  runningRef.current = runPhase !== "idle";
  const readOnlyRef = useRef(false);
  readOnlyRef.current = readOnly;

  const running = runPhase !== "idle";
  const state = store.state;
  // The queue texts are pi-internal: before the first queue_update the bar
  // shows the count get_state reported, so a reload keeps it visible.
  const queueCount = tools.pendingCount ?? tools.steering.length + tools.followUp.length;
  void version;
  void toolVersion;

  const forkFrom = async (text: string, occurrence: number): Promise<void> => {
    const res = await conn.command({ type: "get_fork_messages" });
    if (!res.success) {
      pushToast(res.error ?? "获取分叉点失败", true);
      return;
    }
    const { messages } = res.data as { messages: { entryId: string; text: string }[] };
    // Text alone is ambiguous when the same prompt was sent twice; the
    // occurrence index (nth identical user message) pins the exact fork point.
    const matches = messages.filter((m) => m.text === text);
    const match = matches[Math.min(occurrence, matches.length - 1)];
    if (!match) {
      pushToast("未找到该消息的分叉点", true);
      return;
    }
    const forkRes = await conn.command({ type: "fork", entryId: match.entryId });
    if (forkRes.success) {
      const data = forkRes.data as { cancelled?: boolean };
      if (data.cancelled) pushToast("分叉被扩展取消", true);
      else {
        pushToast("已分叉");
        await rehydrate({ resetUi: true });
      }
    } else {
      pushToast(forkRes.error ?? "分叉失败", true);
    }
  };

  const respondUi = (value: string | undefined, confirmed: boolean | undefined): void => {
    if (!dialog) return;
    // Only the attached tab may answer, and only for the session the dialog
    // came from: the new session's pi would drop an unknown id and leave the
    // old extension waiting forever.
    const dropDialog = (): void => setDialogQueue((q) => q.filter((d) => d.id !== dialog.id));
    if (readOnly) {
      dropDialog();
      pushToast("本页只读，无法回复扩展", true);
      return;
    }
    if (dialog.sessionFile !== store.state.sessionFile) {
      dropDialog();
      pushToast("该对话框属于已离开的会话", true);
      return;
    }
    const response: ExtensionUiResponse =
      dialog.method === "confirm"
        ? { type: "extension_ui_response", id: dialog.id, confirmed }
        : value === undefined
          ? { type: "extension_ui_response", id: dialog.id, cancelled: true }
          : { type: "extension_ui_response", id: dialog.id, value };
    // Must go out verbatim: command() would overwrite the request id with a
    // webui correlation id, and pi would drop the reply as unknown.
    conn.send(response);
    // Pop only the answered dialog; any remaining queued ones surface next.
    dropDialog();
  };

  return (
    <>
      <Topbar
        connState={connState}
        running={running}
        compacting={compacting}
        sessionName={state.sessionName}
        sessionCost={sessionTotals
          ? `↑${fmtTokens(sessionTotals.input)} ↓${fmtTokens(sessionTotals.output)} · $${sessionTotals.cost.toFixed(4)}`
          : null}
        contextUsage={contextUsage}
        onCompact={async () => {
          const res = await conn.command({ type: "compact" });
          if (!res.success) pushToast(res.error ?? "压缩失败", true);
        }}
        gitOpen={showGit}
        onToggleGit={() => setShowGit(!showGit)}
        onToggleTheme={() => setTheme(toggleTheme())}
        theme={theme}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
        todoOpen={panelOpen}
        onToggleTodo={() => {
          if (panelOpen) {
            closePreview();
            setTodoOpen(false);
          } else {
            setTodoOpen(true);
          }
        }}
      />
      <MessageStream
        // A different session is a different view: remounting drops the scroll
        // position and the visible slice of the session left behind.
        key={store.epoch}
        running={running}
        theme={theme}
        onFork={(text, occurrence) => void forkFrom(text, occurrence)}
      />
      {piError ? (
        <div class="retry-banner crash">pi 未能启动：{piError}（请检查 bridge 日志后刷新）</div>
      ) : null}
      {piExited ? (
        <div class="retry-banner crash">
          pi 已退出（code {piExited.code ?? "?"}{piExited.signal ? ` · ${piExited.signal}` : ""}），
          bridge 将自动重启；如未恢复请手动刷新
        </div>
      ) : null}
      {readOnly ? <div class="retry-banner crash">本页已被新标签页接管，处于只读模式</div> : null}
      {queueCount > 0 ? (
        <QueueBar
          count={queueCount}
          onClear={async () => {
            const res = await conn.command({ type: "clear_queue" });
            if (res.success) pushToast("已清空队列");
            else pushToast(res.error ?? "清空队列失败", true);
          }}
        />
      ) : null}
      {retry ? (
        <div class="retry-banner">
          <span class="spinner" />
          重试中 ({retry.attempt}/{retry.maxAttempts})：{retry.errorMessage}
          <button
            class="queue-clear"
            onClick={async () => {
              await conn.command({ type: "abort_retry" });
              setRetry(null);
            }}
          >
            取消重试
          </button>
        </div>
      ) : null}
      <WidgetArea widgets={widgets} />
      <Composer
        running={running}
        commands={commands}
        injected={injected}
        readOnly={readOnly}
        theme={theme}
        model={state.model}
        models={models}
        customEntries={customModels?.entries ?? []}
        thinkingLevel={state.thinkingLevel}
        thinkingLevels={thinkingLevels?.levels ?? null}
        onSetModel={async (provider, modelId) => {
          const res = await conn.command({ type: "set_model", provider, modelId });
          if (res.success) {
            store.setState({ model: res.data as Model });
            // Levels belong to the model: a reasoning model offers more than the
            // "off" a plain one does, so the picker's level row follows along.
            const levelsRes = await conn.command({ type: "get_available_thinking_levels" });
            if (levelsRes.success) setThinkingLevels(levelsRes.data as { levels: string[] });
          } else {
            pushToast(res.error ?? "切换模型失败", true);
          }
        }}
        onSetThinking={async (level) => {
          const res = await conn.command({ type: "set_thinking_level", level });
          if (res.success) store.setState({ thinkingLevel: level });
          else pushToast(res.error ?? "切换推理档失败", true);
        }}
        onAddModel={() => setModelEditor({ entry: null })}
        onEditModel={(entry) => setModelEditor({ entry })}
        onDeleteModel={(entry) => setModelToDelete(entry)}
        onStop={async () => {
          setRunPhase("stopping");
          await conn.command({ type: "abort" });
        }}
        onSendWithMode={async (mode, text, images) => {
          // steer/followUp are dedicated commands valid while running (F-16);
          // queue mode is the plain prompt (pi queues it during a run).
          if (mode === "steer" && running) {
            const res = await conn.command({
              type: "steer",
              message: text,
              ...(images.length > 0 ? { images } : {}),
            });
            if (!res.success) pushToast(res.error ?? "插话失败", true);
            return;
          }
          if (mode === "followUp" && running) {
            const res = await conn.command({
              type: "follow_up",
              message: text,
              ...(images.length > 0 ? { images } : {}),
            });
            if (!res.success) pushToast(res.error ?? "排队失败", true);
            return;
          }
          // prompt without streamingBehavior errors while pi is streaming
          // (rpc-commands.md), so queue mode must declare followUp then.
          const res = await conn.command({
            type: "prompt",
            message: text,
            ...(running ? { streamingBehavior: "followUp" } : {}),
            ...(images.length > 0 ? { images } : {}),
          });
          if (!res.success) pushToast(res.error ?? "发送失败", true);
        }}
      />
      <StatusChips statuses={statuses} />
      {showGit ? <GitView onClose={() => setShowGit(false)} /> : null}
      {sidebarOpen ? (
        <Sidebar
          conn={conn}
          store={store}
          piCwd={piCwd}
          readOnly={readOnly}
          onSwitched={() => {
            // The Git drawer follows the attached cwd, so after a switch it
            // would show another repo.
            setShowGit(false);
            // Extension dialogs, status chips, widgets and the retry banner
            // belong to the session being left.
            void rehydrate({ resetUi: true });
          }}
          onToast={pushToast}
        />
      ) : null}
      {panelOpen ? (
        <RightPanel
          todo={todo}
          preview={preview}
          theme={theme}
          onBack={() => {
            closePreview();
            setTodoOpen(true);
          }}
          onClose={() => {
            closePreview();
            setTodoOpen(false);
          }}
        />
      ) : null}
      {dialog ? <ExtensionDialog key={dialog.id} dialog={dialog} onRespond={respondUi} /> : null}
      {modelEditor === null ? null : (
        <ModelEditor
          snapshot={customModels}
          entry={modelEditor.entry}
          defaultProvider={state.model?.provider ?? null}
          availableProviders={[...new Set(models.map((m) => m.provider))]}
          running={running}
          onCancel={() => setModelEditor(null)}
          onSave={saveModelDraft}
        />
      )}
      {modelToDelete === null ? null : (
        <ModelDeleteDialog
          entry={modelToDelete}
          onCancel={() => setModelToDelete(null)}
          onConfirm={() => void deleteCustomModel(modelToDelete)}
        />
      )}
      <div class="toast-stack">
        {toasts.map((t) => (
          <div key={t.id} class={`toast${t.err ? " err" : ""}`}>
            {t.text}
          </div>
        ))}
      </div>
    </>
  );
}

/** Format a token count for display. */
function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function Topbar(props: {
  connState: ConnState;
  running: boolean;
  compacting: boolean;
  sessionName: string | null;
  sessionCost: string | null;
  contextUsage: ContextUsage;
  onCompact: () => void;
  onToggleGit: () => void;
  gitOpen: boolean;
  onToggleTheme: () => void;
  theme: Theme;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  todoOpen: boolean;
  onToggleTodo: () => void;
}): JSX.Element {
  return (
    <div class="topbar">
      <button
        class={`topbar-btn${props.sidebarOpen ? " active" : ""}`}
        title={props.sidebarOpen ? "收起会话侧栏" : "展开会话侧栏"}
        onClick={props.onToggleSidebar}
      >
        <IconMenu size={14} /> 会话
      </button>
      <button
        class={`topbar-btn${props.todoOpen ? " active" : ""}`}
        title={props.todoOpen ? "收起 ToDo 与文件侧栏" : "展开 ToDo 与文件侧栏"}
        onClick={props.onToggleTodo}
      >
        <IconColumns size={14} /> ToDo
      </button>
      <span class="title">
        <Logo size={22} />
        <span class="title-text">{props.sessionName ?? "Pi"}</span>
      </span>
      <span
        class={`status-dot ${props.running ? "running" : "idle"}`}
        title={props.running ? "运行中" : "空闲"}
      />
      {props.compacting ? <span class="ctx-usage" title="正在压缩上下文，请稍候">压缩中…</span> : null}
      {props.sessionCost ? <span class="session-cost">{props.sessionCost}</span> : null}
      {props.contextUsage ? (
        <span
          class="ctx-usage"
          title={`${props.contextUsage.tokens} / ${props.contextUsage.contextWindow} tokens`}
        >
          上下文 {props.contextUsage.percent}%
        </span>
      ) : null}
      <button class="topbar-btn" title="压缩上下文" onClick={props.onCompact} disabled={props.running}>
        压缩
      </button>
      <button
        class={`topbar-btn${props.gitOpen ? " active" : ""}`}
        title={props.gitOpen ? "关闭 Git 视图（Esc）" : "打开 Git 视图"}
        onClick={props.onToggleGit}
      >
        <IconGit size={14} /> Git
      </button>
      <button
        class="topbar-btn"
        title={props.theme === "dark" ? "切换到亮色" : "切换到暗色"}
        onClick={props.onToggleTheme}
      >
        {props.theme === "dark" ? <IconSun size={14} /> : <IconMoon size={14} />}
      </button>
      <span class={`conn-badge${props.connState === "open" ? "" : " off"}`}>
        {props.connState === "open" ? "已连接" : props.connState === "connecting" ? "连接中…" : "已断开，重连中"}
      </span>
    </div>
  );
}

function QueueBar({ count, onClear }: { count: number; onClear: () => void }): JSX.Element {
  return (
    <div class="queue-bar">
      <span>队列中 {count} 条消息（运行结束后依次处理）</span>
      <button class="queue-clear" onClick={onClear}>
        清空
      </button>
    </div>
  );
}

function MessageStream({
  running,
  theme,
  onFork,
}: {
  running: boolean;
  theme: Theme;
  onFork: (text: string, occurrence: number) => void;
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [follow, setFollow] = useState(true);
  // 分区懒渲染 (PRD 性能): only the tail slice is mounted; "加载更早" grows it.
  const [visibleCount, setVisibleCount] = useState(50);
  // Open file-card disclosures, keyed by turn index. The open flag cannot live
  // in the card: the running turn's card moves to a new host unit on every
  // streamed row, which remounts it and would collapse it under the user.
  const [openFileTurns, setOpenFileTurns] = useState<Set<number>>(new Set());
  const toggleFileTurn = (index: number): void => {
    setOpenFileTurns((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };
  // Only rows that draw something may take a slice slot: a hydrated session
  // has one toolResult row per tool call (rendered as the tool card, not as a
  // row) plus a system message per tool-set change (never rendered). Counting
  // them made "还有 N 条" mostly phantom and could slice a turn in half.
  const visible = renderedRows(store.rows, tools.executions);
  // A bash tool execution is already rendered as a ToolCard in the assistant
  // message; pi also writes a bashExecution transcript row for the same run,
  // so command and output would show twice. Pair them by command text (see
  // duplicateBashRows); a panel-run bash has no execution and stays visible.
  const hiddenBashRows = duplicateBashRows(visible, [...tools.executions.values()]);
  const rows = hiddenBashRows.size === 0 ? visible : visible.filter((row) => !hiddenBashRows.has(row.id));
  // Rows are not what the stream draws: a run of thinking + bash collapses into
  // one summarised unit, and its member rows disappear (see activity-groups).
  const units = groupActivities(rows, running);
  const hiddenCount = Math.max(0, units.length - visibleCount);
  const visibleUnits = units.slice(-visibleCount);
  // The last assistant unit of each turn (just before the next user message, or
  // the end of the stream) carries the time / token footer. A turn's assistant
  // rows are interleaved with toolResult rows, so only a user row closes it.
  const turnEndUnits = new Set<string>();
  let lastAssistantUnit: string | null = null;
  for (const unit of units) {
    const role = unit.kind === "row" ? unit.row.message.role : "assistant";
    if (role === "user") {
      if (lastAssistantUnit) turnEndUnits.add(lastAssistantUnit);
      lastAssistantUnit = null;
    } else if (role === "assistant") {
      lastAssistantUnit = unit.id;
    }
  }
  if (lastAssistantUnit) turnEndUnits.add(lastAssistantUnit);
  // For each user row, which occurrence of its (possibly repeated) text it is;
  // lets fork target the exact message instead of the last textual match.
  const forkOccurrence = new Map<string, number>();
  const textCount = new Map<string, number>();
  for (const unit of units) {
    if (unit.kind !== "row" || unit.row.kind !== "message" || unit.row.message.role !== "user") continue;
    const text = textOf((unit.row.message as UserMessage).content);
    const n = textCount.get(text) ?? 0;
    textCount.set(text, n + 1);
    forkOccurrence.set(unit.id, n);
  }

  const { turns: fileTurns } = sessionFiles(tools);
  // One file card per turn, after that turn's last row: the current turn's card
  // therefore lands at the bottom of the stream, right above the composer. A
  // turn ends where the next row is a user message, or at the end of the rows.
  const fileTurnByIndex = new Map(fileTurns.map((turn) => [turn.index, turn]));
  const cardAfterUnit = new Map<string, (typeof fileTurns)[number]>();
  let turnIndex = 0;
  for (let i = 0; i < units.length; i++) {
    const unit = units[i]!;
    const isUser = unit.kind === "row" && unit.row.message.role === "user";
    if (isUser) turnIndex += 1;
    const next = units[i + 1];
    const nextIsUser = next !== undefined && next.kind === "row" && next.row.message.role === "user";
    const endsTurn = next === undefined || nextIsUser;
    if (!endsTurn) continue;
    const turn = fileTurnByIndex.get(turnIndex);
    if (turn !== undefined) cardAfterUnit.set(unit.id, turn);
  }
  // Turns the user rows cannot place (calls made before any user message) go to
  // the top of the stream instead of being dropped.
  const placed = new Set([...cardAfterUnit.values()].map((turn) => turn.index));
  const orphanTurns = fileTurns.filter((turn) => !placed.has(turn.index));
  const cwd = getPiCwd();

  // Autoscroll (F-18): follow while user is at bottom; pause on manual scroll up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  });

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setFollow(atBottom);
  };

  const scrollToBottom = (): void => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      setFollow(true);
    }
  };

  const loadEarlier = (): void => {
    const el = scrollRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    const prevTop = el?.scrollTop ?? 0;
    if (hiddenCount > 0) {
      setVisibleCount((c) => c + Math.min(100, hiddenCount));
    } else {
      // Nothing older is hidden in the transcript, so the rest of the history is
      // behind the last compaction, which only get_entries still has.
      const earlier = store.takeEarlier();
      if (earlier.length === 0) return;
      const callArgs = callArgsOf(earlier);
      for (const message of earlier) {
        if (message.role !== "toolResult") continue;
        const result = message as ToolResultMessage;
        tools.addFromToolResult(result, callArgs.get(result.toolCallId) ?? {}, ORPHAN_TURN);
      }
      store.prepend(earlier);
      // Reveal the prepended rows in this click instead of one click later.
      setVisibleCount((c) => c + earlier.length);
    }
    // Keep the viewport anchored to the same content after prepending rows:
    // shift by exactly the height that was added above the old position.
    requestAnimationFrame(() => {
      const el2 = scrollRef.current;
      if (el2) el2.scrollTop = prevTop + (el2.scrollHeight - prevHeight);
    });
  };

  // "Load earlier" is worth showing while anything is hidden: rows beyond the
  // slice, or pre-compaction messages get_entries still holds.
  const earlierLabel =
    hiddenCount > 0
      ? `加载更早消息（还有 ${hiddenCount} 条）`
      : store.hasEarlier()
        ? "加载压缩前的历史消息"
        : null;

  return (
    <div class="stream-scroll" ref={scrollRef} onScroll={onScroll}>
      <div class="stream">
        {earlierLabel === null ? null : (
          <button class="load-earlier" onClick={loadEarlier}>
            {earlierLabel}
          </button>
        )}
        {orphanTurns.map((turn) => (
          <div class="narrow" key={`files-${turn.index}`}>
            <TurnFilesCard
              turn={turn}
              cwd={cwd}
              theme={theme}
              open={openFileTurns.has(turn.index)}
              onToggle={() => toggleFileTurn(turn.index)}
            />
          </div>
        ))}
        {rows.length === 0 ? (
          <div class="empty-state">
            <Logo size={40} />
            <div class="es-title">{store.state.sessionName ?? "Pi"}</div>
            <div class="es-hint">输入内容开始对话，/ 唤起命令</div>
          </div>
        ) : (
          visibleUnits.map((unit) => {
            const turn = cardAfterUnit.get(unit.id);
            return (
              <Fragment key={unit.id}>
                {unit.kind === "group" ? (
                  <ActivityGroup
                    unit={unit}
                    toolStore={tools}
                    atTurnEnd={turnEndUnits.has(unit.id)}
                  />
                ) : (
                  <RowView
                    row={unit.row}
                    theme={theme}
                    hidden={unit.hidden}
                    onFork={onFork}
                    forkOccurrence={forkOccurrence.get(unit.id) ?? 0}
                    atTurnEnd={turnEndUnits.has(unit.id)}
                  />
                )}
                {turn === undefined ? null : (
                  <div class="narrow">
                    <TurnFilesCard
                      turn={turn}
                      cwd={cwd}
                      theme={theme}
                      open={openFileTurns.has(turn.index)}
                      onToggle={() => toggleFileTurn(turn.index)}
                    />
                  </div>
                )}
              </Fragment>
            );
          })
        )}
      </div>
      {!follow ? (
        <button class="back-bottom" onClick={scrollToBottom}>
          回到底部
        </button>
      ) : null}
    </div>
  );
}

function RowView({
  row,
  theme,
  hidden,
  onFork,
  forkOccurrence,
  atTurnEnd,
}: {
  row: StreamRow;
  theme: Theme;
  /** Content a folding group above took over; not drawn here. */
  hidden: number[];
  onFork: (text: string, occurrence: number) => void;
  forkOccurrence: number;
  atTurnEnd: boolean;
}): JSX.Element {
  return (
    <MessageView
      message={row.message}
      toolStore={tools}
      theme={theme}
      hidden={hidden}
      onFork={onFork}
      forkOccurrence={forkOccurrence}
      atTurnEnd={atTurnEnd}
    />
  );
}

type DeliveryMode = "queue" | "steer" | "followUp";

const DELIVERY_OPTIONS: { mode: DeliveryMode; label: string; title: string }[] = [
  { mode: "queue", label: "排队", title: "加入队列，按顺序在当前任务后处理（prompt）" },
  { mode: "steer", label: "插话", title: "当前回合的工具执行结束后立即交给模型（steer）" },
  { mode: "followUp", label: "随后", title: "本轮任务完全结束后再处理（follow_up）" },
];

function Composer(props: {
  running: boolean;
  commands: CommandInfo[];
  injected: { v: number; text: string } | null;
  readOnly: boolean;
  theme: Theme;
  model: { id: string; name: string; provider: string } | null;
  models: Model[];
  /** Models added in models.json; each row offers edit and delete. */
  customEntries: ModelEntry[];
  thinkingLevel: string | null;
  thinkingLevels: string[] | null;
  onSetModel: (provider: string, modelId: string) => void;
  onSetThinking: (level: string) => void;
  onAddModel: () => void;
  onEditModel: (entry: ModelEntry) => void;
  onDeleteModel: (entry: ModelEntry) => void;
  onSendWithMode: (mode: DeliveryMode, text: string, images: { data: string; mimeType: string }[]) => void;
  onStop: () => void;
}): JSX.Element {
  // Derived message text of the editor, refreshed on every edit: the editor itself
  // is uncontrolled DOM because chips are not Preact nodes.
  const [draft, setDraft] = useState("");
  const [focus, setFocus] = useState(false);
  // A tree path is hovering the composer: the box shows it accepts the drop.
  const [dropActive, setDropActive] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // Delivery mode matters only while a run is in progress (F-16); queue is
  // the idle default and equals a plain prompt.
  const [mode, setMode] = useState<DeliveryMode>("queue");
  const editorRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const lastInjected = useRef(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Reserve room at the bottom of the message stream equal to the composer's
  // real height (auto-grow textarea aware) so it never covers content.
  // layout effect: set the variable before first paint, no overlap flash.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = (): void => {
      document.documentElement.style.setProperty("--composer-space", `${el.offsetHeight}px`);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Esc cancelling a drag never sends dragleave to the composer, so a highlight
  // left over from a cancelled drag has to be cleared from dragend.
  useEffect(() => {
    if (!dropActive) return;
    const clear = (): void => setDropActive(false);
    window.addEventListener("dragend", clear);
    return () => window.removeEventListener("dragend", clear);
  }, [dropActive]);

  // set_editor_text injection (F-23).
  useEffect(() => {
    if (props.injected && props.injected.v > lastInjected.current) {
      lastInjected.current = props.injected.v;
      const editor = editorRef.current;
      if (editor === null) return;
      setDraftText(editor, props.injected.text);
      syncDraft();
    }
  }, [props.injected]);

  const slashQuery = draft.startsWith("/") && !draft.includes(" ") ? draft.slice(1).toLowerCase() : null;
  const slashMatches = slashQuery !== null
    ? props.commands.filter((c) => c.name.toLowerCase().includes(slashQuery)).slice(0, 8)
    : [];

  const autoGrow = (): void => {
    const editor = editorRef.current;
    if (editor === null) return;
    editor.style.height = "auto";
    const line = 15 * 1.6;
    editor.style.height = `${Math.min(Math.max(editor.scrollHeight, line), line * 8)}px`;
  };

  /** Pull the editor's text into state after any edit, typed or scripted. */
  const syncDraft = (): void => {
    const editor = editorRef.current;
    if (editor === null) return;
    setDraft(draftText(editor));
    autoGrow();
  };

  const addFiles = (files: FileList | File[]): void => {
    const images = [...files].filter((f) => f.type.startsWith("image/"));
    for (const file of images) {
      const reader = new FileReader();
      reader.onload = (): void => {
        const url = String(reader.result);
        const base64 = url.slice(url.indexOf(",") + 1);
        setAttachments((prev) => [
          ...prev,
          { id: ++attachSeq, data: base64, mimeType: file.type, previewUrl: url },
        ]);
      };
      reader.readAsDataURL(file);
    }
  };

  const submit = (): void => {
    if (props.readOnly) return;
    const trimmed = draft.trim();
    if (!trimmed && attachments.length === 0) return;
    const images = attachments.map((a) => ({ data: a.data, mimeType: a.mimeType }));
    const sendMode = props.running ? mode : "queue";
    const message = trimmed || "请看这些图片";
    const editor = editorRef.current;
    if (editor !== null) {
      // Read the chips before clearing: the bubble marks these spans exactly.
      rememberSentChips(message, chipPaths(editor));
      clearDraft(editor);
      // syncDraft puts back the placeholder, which an emptied editor needs.
      syncDraft();
    }
    setAttachments([]);
    requestAnimationFrame(autoGrow);
    props.onSendWithMode(sendMode, message, images);
  };

  const onPaste = (e: ClipboardEvent): void => {
    if (props.readOnly) return;
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.length > 0) {
      e.preventDefault();
      addFiles(files);
      return;
    }
    // Paste as text only: clipboard HTML would drop styled markup into the draft.
    const text = e.clipboardData?.getData("text/plain") ?? "";
    const editor = editorRef.current;
    if (text === "" || editor === null) return;
    e.preventDefault();
    insertDraftText(editor, text);
    syncDraft();
  };

  return (
    <div class="composer-wrap" ref={wrapRef}>
      {slashQuery !== null && slashMatches.length > 0 ? (
        <div class="slash-menu">
          {slashMatches.map((c) => (
            <button
              key={c.name}
              class="slash-item"
              onClick={() => {
                const editor = editorRef.current;
                if (editor === null) return;
                setDraftText(editor, `/${c.name} `);
                syncDraft();
              }}
            >
              <span class="slash-name">/{c.name}</span>
              {c.description ? <span class="slash-desc">{c.description}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
      <div
        class={`composer${focus ? " focus" : ""}${dropActive ? " drop-active" : ""}`}
        onDragOver={(e) => {
          if (props.readOnly || !carriesPath(e.dataTransfer)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setDropActive(true);
        }}
        onDragLeave={(e) => {
          const next = e.relatedTarget;
          if (next instanceof Node && e.currentTarget.contains(next)) return;
          setDropActive(false);
        }}
        onDrop={(e) => {
          const path = e.dataTransfer?.getData(PATH_DRAG_TYPE) ?? "";
          setDropActive(false);
          const editor = editorRef.current;
          if (props.readOnly || path === "" || editor === null) return;
          e.preventDefault();
          insertDraftChip(editor, path, props.theme);
          syncDraft();
        }}
      >
        {attachments.length > 0 ? (
          <div class="attach-row">
            {attachments.map((a) => (
              <div key={a.id} class="attach-thumb">
                <img src={a.previewUrl} alt="附件" />
                <button
                  class="attach-remove"
                  onClick={() => setAttachments((prev) => prev.filter((p) => p.id !== a.id))}
                  title="移除"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <div
          ref={editorRef}
          class={`draft${draft === "" ? " empty" : ""}`}
          contentEditable={!props.readOnly}
          data-placeholder={props.readOnly ? "本页只读" : "输入消息…"}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          onInput={syncDraft}
          onKeyDown={(e) => {
            // Enter during IME composition confirms the candidate, it does not send.
            if (e.isComposing) return;
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          onPaste={onPaste}
        />
        <div class="toolbar">
          {props.running ? (
            <div class="delivery-toggle" role="radiogroup" aria-label="投递方式">
              {DELIVERY_OPTIONS.map((opt) => (
                <button
                  key={opt.mode}
                  title={opt.title}
                  class={`delivery-opt${mode === opt.mode ? " active" : ""}`}
                  onClick={() => setMode(opt.mode)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          ) : null}
          <button class="icon-btn" title="附加图片" onClick={() => fileRef.current?.click()}>
            <IconImage size={17} />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              const files = (e.target as HTMLInputElement).files;
              if (files) addFiles(files);
              (e.target as HTMLInputElement).value = "";
            }}
          />
          <div class="spacer" />
          <span class={`composer-hint${focus ? " faded" : ""}`}>Enter 发送 · / 命令</span>
          <ModelPicker
            model={props.model}
            models={props.models}
            customEntries={props.customEntries}
            thinkingLevel={props.thinkingLevel}
            thinkingLevels={props.thinkingLevels}
            onSetModel={props.onSetModel}
            onSetThinking={props.onSetThinking}
            onAddModel={props.onAddModel}
            onEditModel={props.onEditModel}
            onDeleteModel={props.onDeleteModel}
          />
          {props.running ? (
            <button class="composer-stop" title="停止当前回合" aria-label="停止" onClick={() => props.onStop()}>
              <IconStop size={11} />
            </button>
          ) : (
            <button
              class="composer-send"
              title="发送（Enter）"
              aria-label="发送"
              onClick={submit}
              disabled={!draft.trim() && attachments.length === 0}
            >
              <IconArrowUp size={15} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
