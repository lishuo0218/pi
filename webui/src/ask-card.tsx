// Ask card: one ask_user exchange — the question, the options it offered and
// the answer the user gave (a picked option, a typed answer, or a cancel).
// The answer is parsed from the result text; while the tool waits it shows the
// offered options unmarked plus a running spinner.
import type { JSX } from "preact";
import type { ToolExecution } from "./tool-store";

type Answer =
  | { kind: "pending" }
  | { kind: "selected"; text: string }
  | { kind: "custom"; text: string }
  | { kind: "cancelled" }
  | { kind: "failed"; text: string };

function answerOf(exec: ToolExecution): Answer {
  if (exec.state === "running") return { kind: "pending" };
  const text = exec.resultText.trim();
  // The extension's result text is a wire format: `User selected: X`,
  // `User answered: X` (typed instead of picked) or a cancellation notice.
  const selected = /^User selected: ([\s\S]*)$/.exec(text);
  if (selected) return { kind: "selected", text: selected[1] ?? "" };
  const custom = /^User answered: ([\s\S]*)$/.exec(text);
  if (custom) return { kind: "custom", text: custom[1] ?? "" };
  if (text === "User cancelled the question") return { kind: "cancelled" };
  return { kind: "failed", text: text || "无结果" };
}

function stringArg(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionsArg(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((o): o is string => typeof o === "string") : [];
}

const STATE_LABEL: Record<Answer["kind"], string> = {
  pending: "等待回答",
  selected: "已选择",
  custom: "自定义回答",
  cancelled: "已取消",
  failed: "失败",
};

export function AskCard({ exec }: { exec: ToolExecution }): JSX.Element {
  const question = stringArg(exec.args.question);
  const options = optionsArg(exec.args.options);
  const answer = answerOf(exec);
  const answered = answer.kind === "selected" || answer.kind === "custom" ? answer.text : null;
  const picked = answer.kind === "selected" && options.includes(answer.text) ? answer.text : null;
  // A typed answer (or a picked option we were not given) gets its own row.
  const customRow = answered !== null && answered !== picked;

  return (
    <div class={`ask-card ${exec.state === "running" ? "running" : exec.isError ? "error" : "done"}`}>
      <div class="ask-head">
        <span class="ask-mark">?</span>
        <span class="ask-question">{question || "（无问题文本）"}</span>
        {answer.kind === "pending" ? <span class="spinner" /> : null}
        <span class={`ask-state ${answer.kind}`}>{STATE_LABEL[answer.kind]}</span>
      </div>
      {options.length ? (
        <ul class="ask-options">
          {options.map((option, i) => (
            <li key={i} class={`ask-option${option === picked ? " picked" : ""}`}>
              <span class="ask-bullet" />
              {option}
            </li>
          ))}
          {customRow ? (
            <li class="ask-option picked">
              <span class="ask-bullet" />
              {answered}
            </li>
          ) : null}
        </ul>
      ) : customRow ? (
        <div class="ask-answer">{answered}</div>
      ) : null}
      {answer.kind === "cancelled" ? <div class="ask-note">未回答，用户取消了这次提问</div> : null}
      {answer.kind === "failed" ? <div class="ask-note err">{answer.text}</div> : null}
    </div>
  );
}