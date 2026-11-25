// Temp test harness: mounts EditCard fixtures to verify cwd-relative path
// display and head-collapse truncation, then signals via document.title.
// Run: npx vite --port 5175 --strictPort  +  node tmp-cdp-test.mjs
import { render } from "preact";
import { useEffect } from "preact/hooks";
import "./style.css";
import { EditCard } from "./edit-card";
import { setPiCwd } from "./pi-cwd";
import type { ToolExecution } from "./tool-store";

setPiCwd("D:\\download\\pi\\webui");

function exec(id: string, path: string, diff: string): ToolExecution {
  return {
    toolCallId: id,
    toolName: "edit",
    args: { path },
    turn: { index: 1, timestamp: 0, preview: "" },
    state: "done",
    partial: "",
    resultText: "",
    resultImages: [],
    isError: false,
    durationMs: 1200,
    diff,
  };
}

const narrow = {
  card: exec("t-narrow", "src/core/tools/edit/diff/engine/parser/reader/file.ts", "+1\n-\u200b0"),
  wrap: { width: "260px" },
};

function Harness(): null {
  useEffect(() => {
    document.title = "harness-ready";
  }, []);
  return null;
}

const app = document.createElement("div");
document.body.appendChild(app);

render(
  <>
    <EditCard exec={exec("t-rel", "D:\\download\\pi\\webui\\src\\edit-card.tsx", "+1\n-0")} />
    <EditCard exec={exec("t-outside", "C:\\other\\proj\\a.ts", "+1\n-0")} />
    <div style={narrow.wrap}>
      <EditCard exec={narrow.card} />
    </div>
    <Harness />
  </>,
  app,
);
