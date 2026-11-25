// Bash panel (F-24): direct `bash` RPC commands with streamed output via
// bash_execution_update, abort, and an include-in-context toggle
// (excludeFromContext inverted). History is local to this panel and renders
// with the same BashCard as the message stream.
import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { BashCard } from "./bash-card";
import type { RpcConnection } from "./rpc-connection";
import type { ResponseRecord } from "./protocol";

type BashEntry = {
  id: string;
  command: string;
  output: string;
  running: boolean;
  startedAt: number;
  durationMs?: number;
  exitCode?: number;
  cancelled?: boolean;
  truncated?: boolean;
};

let seq = 0;

export function BashPanel({
  conn,
  onClose,
}: {
  conn: RpcConnection;
  onClose: () => void;
}): JSX.Element {
  const [command, setCommand] = useState("");
  const [includeContext, setIncludeContext] = useState(true);
  const [entries, setEntries] = useState<BashEntry[]>([]);
  const [runningId, setRunningId] = useState<string | null>(null);
  const outRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Streamed output for the running bash command (json.md RPC-only events).
    const unsub = conn.onRecord((record) => {
      if (record.type !== "bash_execution_update") return;
      const delta = (record as { id?: string; delta?: string }).delta ?? "";
      const id = (record as { id?: string }).id;
      if (!id) return;
      setEntries((prev) =>
        prev.map((e) => (e.id === id ? { ...e, output: e.output + delta } : e)),
      );
    });
    return unsub;
  }, [conn]);

  // Autoscroll while entries change.
  useEffect(() => {
    const el = outRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  const run = async (): Promise<void> => {
    const trimmed = command.trim();
    if (!trimmed || runningId) return;
    const id = `bash-${++seq}`;
    setCommand("");
    setEntries((prev) => [
      ...prev,
      { id, command: trimmed, output: "", running: true, startedAt: Date.now() },
    ]);
    setRunningId(id);
    const res = (await conn.command({
      type: "bash",
      command: trimmed,
      ...(includeContext ? {} : { excludeFromContext: true }),
      id,
    })) as ResponseRecord;
    setRunningId(null);
    const data = res.data as
      | { output?: string; exitCode?: number; cancelled?: boolean; truncated?: boolean }
      | undefined;
    setEntries((prev) =>
      prev.map((e) =>
        e.id === id
          ? {
              ...e,
              running: false,
              durationMs: Date.now() - e.startedAt,
              // Final response replaces the streamed partial (authoritative).
              output: data?.output ?? e.output,
              exitCode: data?.exitCode,
              cancelled: data?.cancelled,
              truncated: data?.truncated,
            }
          : e,
      ),
    );
  };

  const abort = async (): Promise<void> => {
    await conn.command({ type: "abort_bash" });
  };

  return (
    <div class="bash-panel">
      <div class="bash-head">
        <span>Bash 面板</span>
        <button class="panel-btn" onClick={onClose}>
          ✕
        </button>
      </div>
      <div class="bash-out" ref={outRef}>
        {entries.length === 0 ? (
          <div class="panel-empty">输出会附加到会话上下文，随下一条消息发给模型</div>
        ) : (
          entries.map((e) => (
            <BashCard
              key={e.id}
              run={{
                command: e.command,
                output: e.output,
                running: e.running,
                durationMs: e.durationMs,
                exitCode: e.exitCode,
                status: e.cancelled ? "已取消" : undefined,
                truncated: e.truncated,
              }}
              behavior={{ kind: "pinned" }}
            />
          ))
        )}
      </div>
      <div class="bash-input-row">
        <input
          class="bash-input"
          placeholder="shell 命令，Enter 运行"
          value={command}
          disabled={runningId !== null}
          onKeyDown={(e) => {
            if (e.key === "Enter") void run();
          }}
          onInput={(e) => setCommand((e.target as HTMLInputElement).value)}
        />
        {runningId ? (
          <button class="btn-stop" onClick={() => void abort()}>
            中止
          </button>
        ) : (
          <button class="btn-send" disabled={!command.trim()} onClick={() => void run()}>
            运行
          </button>
        )}
      </div>
      <label class="bash-ctx-toggle">
        <input
          type="checkbox"
          checked={includeContext}
          onChange={(e) => setIncludeContext((e.target as HTMLInputElement).checked)}
        />
        输出纳入会话上下文
      </label>
    </div>
  );
}
