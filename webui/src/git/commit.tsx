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
  const canCommit = message.trim() !== "" && (amend || staged > 0) && !store.busy && !store.drafting;
  // While a draft streams the button stops it instead of starting another.
  const canDraft = store.drafting || (status.files.length > 0 && !store.busy);

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
    // Snapshots replace the box content as the model writes, so the text is
    // never briefly empty and a stop keeps whatever already arrived.
    const text = await store.draftMessage(setMessage);
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
        // Read-only while the model writes: the snapshots are the content.
        readOnly={store.drafting}
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
          title={
            store.drafting
              ? "停止生成，保留已生成的部分"
              : staged === 0
                ? "用全部待提交改动生成提交说明"
                : "用已暂存的改动生成提交说明"
          }
          onClick={() => {
            if (!canDraft) return;
            if (store.drafting) {
              store.stopDraft();
              return;
            }
            if (message.trim() === "") void draft();
            else store.requestConfirm("输入框里已有提交说明，覆盖它？", "覆盖", () => void draft());
          }}
        >
          {store.drafting ? "停止" : "AI 生成"}
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
          {store.drafting
            ? "模型正在生成，输入框暂不可编辑"
            : amend
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