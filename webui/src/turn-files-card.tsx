// The files the agent changed in one turn, kept at the end of that turn in the
// stream. Collapsed by default to a single line: file count plus the lines this
// turn added and removed; expanding lists each file with its own counts.
import { useState } from "preact/hooks";
import type { JSX } from "preact";
import type { SessionTurn } from "./session-files";
import { IconChevron } from "./icons";
import { PathLabel, relativeToCwd, splitPath } from "./path-label";
import { FileIcon } from "./file-icon";
import { Collapse } from "./collapse";
import type { Theme } from "./theme";

/** "+N −M" badges; a zero count on either side is left out. */
function LineStats({ added, removed }: { added: number; removed: number }): JSX.Element | null {
  if (added + removed === 0) return null;
  return (
    <span class="file-stats">
      {added > 0 ? <span class="stat-add">+{added}</span> : null}
      {removed > 0 ? <span class="stat-del">−{removed}</span> : null}
    </span>
  );
}

export function TurnFilesCard({
  turn,
  cwd,
  theme,
}: {
  turn: SessionTurn;
  /** pi's working directory, for the shortened paths. */
  cwd: string | null;
  theme: Theme;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div class={`turn-files-card${open ? " open" : ""}`}>
      <button
        class="turn-files-head"
        title={open ? "收起本轮的改动" : "展开本轮的改动"}
        onClick={() => setOpen(!open)}
      >
        <span class="caret">
          <IconChevron />
        </span>
        <span class="turn-files-count">改动 {turn.files.length} 个文件</span>
        <LineStats added={turn.added} removed={turn.removed} />
      </button>
      <Collapse open={open}>
        <ul class="turn-files-body">
          {turn.files.map((file) => {
            const shown = relativeToCwd(file.path, cwd) ?? file.path;
            const { dir, name } = splitPath(shown);
            return (
              <li key={file.path} class="file-item">
                <FileIcon path={file.path} theme={theme} />
                <PathLabel dir={dir} name={name} title={file.path} />
                <LineStats added={file.added} removed={file.removed} />
              </li>
            );
          })}
        </ul>
      </Collapse>
    </div>
  );
}