// Todo tool card: `set` records the checklist it laid out (bar plus the task
// list as its body), `check` records one toggled entry (a single line with the
// task and its progress). The checklist itself lives in the right panel; these
// cards are the transcript of how it changed.
import type { JSX } from "preact";
import type { ToolExecution } from "./tool-store";
import type { TodoTask } from "./protocol";
import { ToolFrame } from "./tool-frame";

type CheckResult = {
  /** Task text the tool reports as toggled. */
  text: string;
  /** Target state from the result text (`checked` / `unchecked`). */
  done: boolean;
  doneCount: number;
  total: number;
};

/** `抽出工具路径… checked (3/6 done).` — the todo tool's result text for `check`. */
function checkResultOf(resultText: string): CheckResult | null {
  const match = /^([\s\S]*) (checked|unchecked) \((\d+)\/(\d+) done\)\.$/.exec(resultText.trim());
  if (!match) return null;
  return {
    text: match[1] ?? "",
    done: match[2] === "checked",
    doneCount: Number(match[3]),
    total: Number(match[4]),
  };
}

/** The tasks carried in `set` args (wire input: validated field by field). */
function tasksOf(value: unknown): TodoTask[] {
  if (!Array.isArray(value)) return [];
  const tasks: TodoTask[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const { text, done } = item as { text?: unknown; done?: unknown };
    if (typeof text === "string" && typeof done === "boolean") tasks.push({ text, done });
  }
  return tasks;
}

function TaskList({ tasks }: { tasks: TodoTask[] }): JSX.Element {
  return (
    <ul class="todo-card-list">
      {tasks.map((task, i) => (
        <li key={i} class={`todo-card-item${task.done ? " done" : ""}`}>
          <span class="todo-card-bullet" />
          <span class="todo-card-text">{task.text}</span>
        </li>
      ))}
    </ul>
  );
}

export function TodoCard({ exec }: { exec: ToolExecution }): JSX.Element {
  const running = exec.state === "running";
  const label = <span class="frame-name">todo</span>;

  if (exec.args.action === "check") {
    const result = running || exec.isError ? null : checkResultOf(exec.resultText);
    const title = result?.text ?? (running ? "更新清单…" : exec.resultText.trim() || "更新清单");
    return (
      <ToolFrame
        id={exec.toolCallId}
        running={running}
        failed={exec.isError}
        durationMs={exec.durationMs}
        label={label}
        title={<span class="frame-raw">{title}</span>}
        titleAttr={title}
        meta={
          result ? (
            <span class={`todo-card-state${result.done ? " done" : ""}`}>
              {result.done ? "完成" : "取消完成"} {result.doneCount}/{result.total}
            </span>
          ) : null
        }
      >
        {exec.isError ? <div class="list-error">{exec.resultText.trim()}</div> : undefined}
      </ToolFrame>
    );
  }

  const tasks = tasksOf(exec.args.tasks);
  const doneCount = tasks.filter((task) => task.done).length;
  const title = tasks.length > 0 ? `设置清单 · ${tasks.length} 项` : "设置清单";
  return (
    <ToolFrame
      id={exec.toolCallId}
      running={running}
      failed={exec.isError}
      durationMs={exec.durationMs}
      label={label}
      title={<span class="frame-raw">{title}</span>}
      titleAttr={title}
      meta={<span class="todo-card-state">{doneCount}/{tasks.length}</span>}
    >
      {tasks.length > 0 ? <TaskList tasks={tasks} /> : <div class="list-empty">（空清单）</div>}
    </ToolFrame>
  );
}