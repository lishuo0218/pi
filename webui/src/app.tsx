// Root app (M3): M1/M2 features plus session panel (F-20/F-21), fork
// (F-21), slash command autocomplete (F-22), extension UI mapping (F-23),
// bash panel (F-24), Git drawer, compaction + context usage (F-25), retry
// banner (F-26), full-screen Git view (F-29).
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
import { closePreview, getPreviewRequest, onPreviewChange } from "./preview-target";
import { Logo } from "./logo";
import { IconGit, IconImage, IconMenu, IconMoon, IconSun, IconColumns } from "./icons";
import { BashPanel } from "./bash-panel";
import { GitView } from "./git/git-view";
import { sessionFiles } from "./session-files";
import { TurnFilesCard } from "./turn-files-card";
import { getPiCwd } from "./pi-cwd";
import { setPiCwd as reportPiCwd } from "./pi-cwd";
import { initTheme, toggleTheme, watchSystemTheme, type Theme } from "./theme";
import { DEFAULT_KEYBINDINGS, matchesKey } from "./keybindings";
import type { AgentMessage, AssistantMessage, CommandInfo, ExtensionUiDialog, ExtensionUiResponse, Model, ToolResultMessage, UserMessage } from "./protocol";

const store = new SessionStore();
const tools = new ToolStore();
const todo = new TodoStore();
const conn = new RpcConnection();

type ThinkingLevels = { levels: string[] } | null;
type ContextUsage = { tokens: number; contextWindow: number; percent: number } | null;

type Attachment = { id: number; data: string; mimeType: string; previewUrl: string };
let attachSeq = 0;

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
  const [thinkingLevels, setThinkingLevels] = useState<ThinkingLevels>(null);
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [toasts, setToasts] = useState<{ id: number; text: string; err: boolean }[]>([]);
  // pi can hold several dialogs pending at once (each extension_ui_request
  // has its own id on the agent side), so they queue FIFO: answering the
  // front one reveals the next instead of dropping earlier requests.
  const [dialogQueue, setDialogQueue] = useState<ExtensionUiDialog[]>([]);
  const dialog = dialogQueue[0] ?? null;
  const [statuses, setStatuses] = useState(new Map<string, string>());
  const [widgets, setWidgets] = useState(new Map<string, { lines: string[]; placement: string }>());
  const [retry, setRetry] = useState<RetryInfo | null>(null);
  const [contextUsage, setContextUsage] = useState<ContextUsage>(null);
  const [sessionTotals, setSessionTotals] = useState<{ input: number; output: number; cost: number } | null>(null);
  const [showBash, setShowBash] = useState(false);
  const [showGit, setShowGit] = useState(false);
  const [todoOpen, setTodoOpen] = useState(true);
  // The panel's file preview is opened from leaf components (file tree, tool
  // cards) through preview-target.ts, so the root only subscribes to it.
  const [preview, setPreview] = useState(getPreviewRequest);
  useEffect(() => onPreviewChange(() => setPreview(getPreviewRequest())), []);
  const [previewWidth, setPreviewWidth] = useState(getPreviewWidth);
  useEffect(() => onPreviewWidthChange(() => setPreviewWidth(getPreviewWidth())), []);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [injected, setInjected] = useState<{ v: number; text: string } | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [piExited, setPiExited] = useState<{ code: number | null; signal: string | null } | null>(null);
  const [piCwd, setPiCwd] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(initTheme);
  const injectSeq = useRef(0);
  const toastSeq = useRef(0);

  // The stream/composer/banners shift left by this var when the sidebar shows.
  useLayoutEffect(() => {
    document.documentElement.style.setProperty("--sidebar-w", sidebarOpen ? "260px" : "0px");
  }, [sidebarOpen]);

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

  // Full rehydration after session switch / fork (F-01 again).
  const rehydrate = async (): Promise<void> => {
    tools.clear();
    todo.clear();
    const [stateRes, messagesRes] = await Promise.all([
      conn.command({ type: "get_state" }),
      conn.command({ type: "get_messages" }),
    ]);
    if (stateRes.success) {
      const data = stateRes.data as {
        model?: Model;
        thinkingLevel?: string;
        isStreaming?: boolean;
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
    }
    if (messagesRes.success) {
      const { messages } = messagesRes.data as { messages: AgentMessage[] };
      // toolResult messages carry no call args; the matching assistant
      // message's toolCall block does. Collect them first so hydrated cards
      // keep their path/command summaries (F-12).
      const callArgs = new Map<string, Record<string, unknown>>();
      for (const m of messages) {
        if ((m as { role?: string }).role !== "assistant") continue;
        for (const block of (m as AssistantMessage).content ?? []) {
          if (block.type === "toolCall") {
            const args = block.arguments;
            if (args && typeof args === "object" && !Array.isArray(args)) {
              callArgs.set(block.id, args as Record<string, unknown>);
            }
          }
        }
      }
      for (const m of messages) {
        const role = (m as { role?: string }).role;
        if (role === "user") {
          // Count turns in the same order the live binder did, so files keep
          // their turn grouping after a switch or reload.
          const user = m as UserMessage;
          tools.beginTurn(user.timestamp, turnPreview(user.content));
        } else if (role === "toolResult") {
          tools.addFromToolResult(m as ToolResultMessage, callArgs.get((m as ToolResultMessage).toolCallId) ?? {});
          // Restore the checklist from the last todo tool result.
          if ((m as ToolResultMessage).toolName === "todo") {
            const details = (m as unknown as { details?: Record<string, unknown> }).details;
            todo.setFromDetails(details);
          }
        }
      }
      store.hydrate(messages, store.state);
    }
    // A session (and possibly cwd) switch invalidates the open preview path.
    closePreview();
    // get_messages has no in-progress message: ask the bridge to replay the
    // records of the turn still streaming (page reload / session switch in
    // the middle of a run). They arrive before this response and land in the
    // store the binder just hydrated.
    await conn.command({ type: "bridge_resume" });
    await refreshStats();
  };

  useEffect(() => {
    const unsubState = conn.onState(setConnState);
    // M4 lifecycle/notice records (not protocol events, bridge-owned).
    const unsubLifecycle = conn.onRecord((record) => {
      const type = record.type;
      if (type === "pi_exited") {
        const ev = record as { code?: number | null; signal?: string | null };
        setPiExited({ code: ev.code ?? null, signal: ev.signal ?? null });
        setRunPhase("idle");
      } else if (type === "pi_started") {
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
          void rehydrate();
        }
        // Protocol-match hint (PRD: 协议回退): piVersion empty = probe failed.
        if ((record as { piVersion?: string }).piVersion === "") {
          pushToast("pi 版本未知，协议可能不匹配", true);
        }
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
                return [...q, req];
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
        const [modelsRes, levelsRes, commandsRes] = await Promise.all([
          conn.command({ type: "get_available_models" }),
          conn.command({ type: "get_available_thinking_levels" }),
          conn.command({ type: "get_commands" }),
        ]);
        if (modelsRes.success) {
          const { models: list } = modelsRes.data as { models: Model[] };
          setModels(list);
        }
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
      if (dialog) return;
      if (runningRef.current && !readOnlyRef.current && matchesKey(e, DEFAULT_KEYBINDINGS.abort)) {
        e.preventDefault();
        setRunPhase("stopping");
        void conn.command({ type: "abort" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialog]);
  const runningRef = useRef(false);
  runningRef.current = runPhase !== "idle";
  const readOnlyRef = useRef(false);
  readOnlyRef.current = readOnly;

  const running = runPhase !== "idle";
  const state = store.state;
  const queueCount = tools.steering.length + tools.followUp.length;
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
        await rehydrate();
      }
    } else {
      pushToast(forkRes.error ?? "分叉失败", true);
    }
  };

  const respondUi = (value: string | undefined, confirmed: boolean | undefined): void => {
    if (!dialog) return;
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
    setDialogQueue((q) => q.filter((d) => d.id !== dialog.id));
  };

  return (
    <>
      <Topbar
        connState={connState}
        running={running}
        sessionName={state.sessionName}
        model={state.model}
        models={models}
        thinkingLevel={state.thinkingLevel}
        thinkingLevels={thinkingLevels?.levels ?? null}
        sessionCost={sessionTotals
          ? `↑${fmtTokens(sessionTotals.input)} ↓${fmtTokens(sessionTotals.output)} · $${sessionTotals.cost.toFixed(4)}`
          : null}
        contextUsage={contextUsage}
        onSetModel={async (provider, modelId) => {
          const res = await conn.command({ type: "set_model", provider, modelId });
          if (res.success) {
            store.setState({ model: res.data as Model });
          } else {
            pushToast(res.error ?? "切换模型失败", true);
          }
        }}
        onSetThinking={async (level) => {
          const res = await conn.command({ type: "set_thinking_level", level });
          if (res.success) store.setState({ thinkingLevel: level });
          else pushToast(res.error ?? "切换推理档失败", true);
        }}
        onCompact={async () => {
          const res = await conn.command({ type: "compact" });
          if (!res.success) pushToast(res.error ?? "压缩失败", true);
        }}
        onToggleBash={() => {
          setShowBash(!showBash);
          setShowGit(false);
        }}
        gitOpen={showGit}
        onToggleGit={() => {
          setShowGit(!showGit);
          setShowBash(false);
        }}
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
        running={running}
        theme={theme}
        onFork={(text, occurrence) => void forkFrom(text, occurrence)}
      />
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
      {showBash ? <BashPanel conn={conn} onClose={() => setShowBash(false)} /> : null}
      {showGit ? <GitView onClose={() => setShowGit(false)} /> : null}
      {sidebarOpen ? (
        <Sidebar
          conn={conn}
          store={store}
          piCwd={piCwd}
          onSwitched={() => {
            // The bash panel's output belongs to the session being left; it
            // cannot be rebuilt from get_state/get_messages. The Git drawer
            // follows the attached cwd, so it would show another repo.
            setShowBash(false);
            setShowGit(false);
            void rehydrate();
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
  sessionName: string | null;
  model: { id: string; name: string; provider: string } | null;
  models: Model[];
  thinkingLevel: string | null;
  thinkingLevels: string[] | null;
  sessionCost: string | null;
  contextUsage: ContextUsage;
  onSetModel: (provider: string, modelId: string) => void;
  onSetThinking: (level: string) => void;
  onCompact: () => void;
  onToggleBash: () => void;
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
      <button class="topbar-btn" onClick={props.onToggleBash}>
        Bash
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
      <select
        value={props.model ? `${props.model.provider}/${props.model.id}` : ""}
        onChange={(e) => {
          const key = (e.target as HTMLSelectElement).value;
          const [provider = "", ...rest] = key.split("/");
          void props.onSetModel(provider, rest.join("/"));
        }}
        aria-label="模型"
      >
        {props.model ? (
          <option value={`${props.model.provider}/${props.model.id}`}>
            {props.model.name ?? props.model.id}
          </option>
        ) : (
          <option value="">未选择模型</option>
        )}
        {props.models
          .filter((m) => !props.model || m.id !== props.model.id || m.provider !== props.model.provider)
          .map((m) => (
            <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
              {m.name ?? m.id}
            </option>
          ))}
      </select>
      {props.thinkingLevels && props.thinkingLevels.length > 1 ? (
        <select
          value={props.thinkingLevel ?? "off"}
          onChange={(e) => void props.onSetThinking((e.target as HTMLSelectElement).value)}
          aria-label="推理档"
        >
          {props.thinkingLevels.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      ) : null}
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
  const rows = store.rows;
  const hiddenCount = Math.max(0, rows.length - visibleCount);
  const visibleRows = rows.slice(-visibleCount);
  // A bash tool execution is already rendered as a ToolCard in the assistant
  // message; pi also adds a bashExecution transcript row for the same run, so
  // the command and output would show twice. Pair transcript rows with the
  // store's bash executions in order and hide the matched rows. Live
  // executions and hydrated ones (args restored from the assistant toolCall
  // block) pair by exact command; panel-run bash has no tool execution, so
  // its row is never paired and stays visible.
  const bashExecutions = [...tools.executions.values()].filter((e) => e.toolName === "bash");
  const hiddenBashRows = new Set<string>();
  let bashRowIndex = 0;
  for (const row of rows) {
    if (row.kind === "message" && row.message.role === "bashExecution") {
      const bash = row.message as { command: string };
      const exec = bashExecutions[bashRowIndex];
      if (exec && (exec.args.command ? exec.args.command === bash.command : true)) {
        hiddenBashRows.add(row.id);
      }
      bashRowIndex += 1;
    }
  }
  // The last assistant row of each turn (just before the next user message, or
  // the end of the stream) carries the time / token footer. A turn's assistant
  // rows are interleaved with toolResult rows, so only a user row closes it.
  const turnEndRows = new Set<string>();
  let lastAssistantRow: string | null = null;
  for (const row of rows) {
    if (row.kind !== "message") continue;
    if (row.message.role === "user") {
      if (lastAssistantRow) turnEndRows.add(lastAssistantRow);
      lastAssistantRow = null;
    } else if (row.message.role === "assistant") {
      lastAssistantRow = row.id;
    }
  }
  if (lastAssistantRow) turnEndRows.add(lastAssistantRow);
  // For each user row, which occurrence of its (possibly repeated) text it is;
  // lets fork target the exact message instead of the last textual match.
  const forkOccurrence = new Map<string, number>();
  const textCount = new Map<string, number>();
  for (const row of rows) {
    if (row.kind === "message" && row.message.role === "user") {
      const text = textOf((row.message as UserMessage).content);
      const n = textCount.get(text) ?? 0;
      textCount.set(text, n + 1);
      forkOccurrence.set(row.id, n);
    }
  }

  const { turns: fileTurns } = sessionFiles(tools);
  // One file card per turn, after that turn's last row: the current turn's card
  // therefore lands at the bottom of the stream, right above the composer. A
  // turn ends where the next row is a user message, or at the end of the rows.
  const fileTurnByIndex = new Map(fileTurns.map((turn) => [turn.index, turn]));
  const cardAfterRow = new Map<string, (typeof fileTurns)[number]>();
  let turnIndex = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.kind === "message" && row.message.role === "user") turnIndex += 1;
    const next = rows[i + 1];
    const endsTurn = next === undefined || (next.kind === "message" && next.message.role === "user");
    if (!endsTurn) continue;
    const turn = fileTurnByIndex.get(turnIndex);
    if (turn !== undefined) cardAfterRow.set(row.id, turn);
  }
  // Turns the user rows cannot place (calls made before any user message) go to
  // the top of the stream instead of being dropped.
  const placed = new Set([...cardAfterRow.values()].map((turn) => turn.index));
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
    setVisibleCount((c) => c + 100);
    // Keep the viewport anchored to the same content after prepending rows:
    // shift by exactly the height that was added above the old position.
    requestAnimationFrame(() => {
      const el2 = scrollRef.current;
      if (el2) el2.scrollTop = prevTop + (el2.scrollHeight - prevHeight);
    });
  };

  return (
    <div class="stream-scroll" ref={scrollRef} onScroll={onScroll}>
      <div class="stream">
        {hiddenCount > 0 ? (
          <button class="load-earlier" onClick={loadEarlier}>
            加载更早消息（还有 {hiddenCount} 条）
          </button>
        ) : null}
        {orphanTurns.map((turn) => (
          <div class="narrow" key={`files-${turn.index}`}>
            <TurnFilesCard turn={turn} cwd={cwd} theme={theme} />
          </div>
        ))}
        {rows.length === 0 ? (
          <div class="empty-state">
            <Logo size={40} />
            <div class="es-title">{store.state.sessionName ?? "Pi"}</div>
            <div class="es-hint">输入内容开始对话，/ 唤起命令</div>
          </div>
        ) : (
          visibleRows.map((row) => {
            const turn = cardAfterRow.get(row.id);
            return (
              <Fragment key={row.id}>
                <RowView
                  row={row}
                  hideBash={hiddenBashRows.has(row.id)}
                  onFork={onFork}
                  forkOccurrence={forkOccurrence.get(row.id) ?? 0}
                  atTurnEnd={turnEndRows.has(row.id)}
                />
                {turn === undefined ? null : (
                  <div class="narrow">
                    <TurnFilesCard turn={turn} cwd={cwd} theme={theme} />
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
  hideBash,
  onFork,
  forkOccurrence,
  atTurnEnd,
}: {
  row: StreamRow;
  hideBash: boolean;
  onFork: (text: string, occurrence: number) => void;
  forkOccurrence: number;
  atTurnEnd: boolean;
}): JSX.Element {
  return (
    <MessageView
      message={row.message}
      toolStore={tools}
      hideBash={hideBash}
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
  onSendWithMode: (mode: DeliveryMode, text: string, images: { data: string; mimeType: string }[]) => void;
  onStop: () => void;
}): JSX.Element {
  const [text, setText] = useState("");
  const [focus, setFocus] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // Delivery mode matters only while a run is in progress (F-16); queue is
  // the idle default and equals a plain prompt.
  const [mode, setMode] = useState<DeliveryMode>("queue");
  const taRef = useRef<HTMLTextAreaElement | null>(null);
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

  // set_editor_text injection (F-23).
  useEffect(() => {
    if (props.injected && props.injected.v > lastInjected.current) {
      lastInjected.current = props.injected.v;
      setText(props.injected.text);
      const ta = taRef.current;
      if (ta) {
        ta.focus();
        requestAnimationFrame(autoGrow);
      }
    }
  }, [props.injected]);

  const slashQuery = text.startsWith("/") && !text.includes(" ") ? text.slice(1).toLowerCase() : null;
  const slashMatches = slashQuery !== null
    ? props.commands.filter((c) => c.name.toLowerCase().includes(slashQuery)).slice(0, 8)
    : [];

  const autoGrow = (): void => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const line = 15 * 1.6;
    ta.style.height = `${Math.min(Math.max(ta.scrollHeight, line), line * 8)}px`;
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
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;
    const images = attachments.map((a) => ({ data: a.data, mimeType: a.mimeType }));
    const sendMode = props.running ? mode : "queue";
    setText("");
    setAttachments([]);
    requestAnimationFrame(autoGrow);
    props.onSendWithMode(sendMode, trimmed || "请看这些图片", images);
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const onPaste = (e: ClipboardEvent): void => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.length > 0) {
      e.preventDefault();
      addFiles(files);
    }
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
                setText(`/${c.name} `);
                taRef.current?.focus();
              }}
            >
              <span class="slash-name">/{c.name}</span>
              {c.description ? <span class="slash-desc">{c.description}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
      <div class={`composer${focus ? " focus" : ""}`}>
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
        <textarea
          ref={taRef}
          rows={1}
          disabled={props.readOnly}
          placeholder={props.readOnly ? "本页只读" : "输入内容，Enter 发送，/ 唤起命令，Shift+Enter 换行"}
          value={text}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          onInput={(e) => {
            setText((e.target as HTMLTextAreaElement).value);
            autoGrow();
          }}
          onKeyDown={onKeyDown}
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
            <IconImage size={18} />
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
          {props.running ? (
            <button class="btn-stop" onClick={() => props.onStop()}>
              停止
            </button>
          ) : (
            <button
              class="btn-send"
              onClick={submit}
              disabled={!text.trim() && attachments.length === 0}
            >
              发送
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
