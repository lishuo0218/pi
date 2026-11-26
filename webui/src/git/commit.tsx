// Commit box of the Git view: message, amend toggle and the counts the decision
// depends on (staged files, unborn branch). Ctrl+Enter commits, and the AI
// draft fills the box after asking before it overwrites typed text.
import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import type { GitStatus } from "../../bridge/git/types";
import type { GitStore } from "./store";

/**
 * Keep the box as tall as its text. The CSS max-height caps the growth, so a
 * long message scrolls inside the box instead of pushing the file list away.
 */
function autosize(box: HTMLTextAreaElement): void {
  // border-box: the border is not part of scrollHeight, so add it back before
  // setting the height, or a scrollbar appears one border-width too early.
  const border = box.offsetHeight - box.clientHeight;
  box.style.height = "auto";
  box.style.height = `${box.scrollHeight + border}px`;
}

export function GitCommitBox({ store, status }: { store: GitStore; status: GitStatus }): JSX.Element {
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const box = useRef<HTMLTextAreaElement | null>(null);
  const staged = status.files.filter((file) => !file.untracked && file.conflict === null && file.index !== ".").length;
  const canCommit = message.trim() !== "" && (amend || staged > 0) && !store.busy;
  const canDraft = status.files.length > 0 && !store.busy && !store.drafting;

  // The AI draft and the reset after a commit both change the text from
  // outside this component's input event, so the height follows the value.
  useEffect(() => {
    if (box.current !== null) autosize(box.current);
  }, [message]);

  const submit = async (): Promise<void> => {
    if (!canCommit) return;
    const ok = await store.commit(message, amend);
    if (!ok) return;
    setMessage("");
    setAmend(false);
  };

  const draft = async (): Promise<void> => {
    const text = await store.draftMessage();
    if (text !== null) setMessage(text);
  };

  return (
    <div class="gv-commit-box">
      <textarea
        ref={box}
        class="gv-commit-input"
        value={message}
        rows={3}
        placeholder="提交说明（Ctrl+Enter 提交）"
        spellcheck={false}
        onInput={(event) => setMessage(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <div class="gv-commit-row">
        <button
          class="gv-mini"
          disabled={!canDraft}
          title={staged === 0 ? "用全部待提交改动生成提交说明" : "用已暂存的改动生成提交说明"}
          onClick={() => {
            if (!canDraft) return;
            if (message.trim() === "") void draft();
            else store.requestConfirm("输入框里已有提交说明，覆盖它？", "覆盖", () => void draft());
          }}
        >
          {store.drafting ? "生成中…" : "AI 生成"}
        </button>
        <label class="gv-check" title={status.unborn ? "还没有提交可以修补" : "替换上一次提交"}>
          <input
            type="checkbox"
            checked={amend}
            disabled={status.unborn || store.busy}
            onChange={(event) => setAmend(event.currentTarget.checked)}
          />
          修补上次
        </label>
        <span class="gv-commit-hint">
          {amend
            ? "将替换上一次提交"
            : staged === 0
              ? "先暂存要提交的改动"
              : `已暂存 ${staged} 个文件`}
        </span>
        <span class="gv-head-spacer" />
        <button class="gv-primary" disabled={!canCommit} onClick={() => void submit()}>
          {amend ? "修补提交" : "提交"}
        </button>
      </div>
    </div>
  );
}