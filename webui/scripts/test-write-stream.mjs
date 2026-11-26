// End-to-end write streaming test with a local mock model: the write card must
// show the written file, its growing line count and size while the model is
// still emitting the tool call, not only once the tool has run. The mock sends
// the content before the path, in small chunks, so the bar has to name a call
// with no arguments yet.
// Run npm run build first, then: node scripts/test-write-stream.mjs
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import WebSocket from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(ok ? "PASS" : "FAIL", name, extra);
  if (!ok) failures++;
};

const root = mkdtempSync(join(tmpdir(), "pi-write-stream-"));
const agentDir = join(root, "agent");
const sessionsDir = join(root, "sessions");
const workspace = join(root, "ws");
for (const dir of [agentDir, sessionsDir, workspace]) mkdirSync(dir, { recursive: true });

const LINES = 200;
const CHUNK = 40;
const DELAY = 12;
const content = Array.from({ length: LINES }, (_, i) => `export const value${i} = ${i};`).join("\n") + "\n";
// Content before path on purpose: the model chooses the order.
const argsJson = JSON.stringify({ content, path: "src/generated.ts" });

const MOCK_PORT = 5311;
let calls = 0;
const mock = http.createServer(async (req, res) => {
  if (!req.url?.includes("/chat/completions")) return void res.writeHead(404).end();
  const call = ++calls;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (delta, finish = null) =>
    res.write(
      `data: ${JSON.stringify({
        id: `mock-${call}`,
        object: "chat.completion.chunk",
        created: 0,
        model: "wr",
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`,
    );
  req.on("error", () => {});
  res.on("error", () => {});
  send({ role: "assistant", content: "" });
  if (call === 1) {
    send({
      tool_calls: [{ index: 0, id: "call_write_1", type: "function", function: { name: "write", arguments: "" } }],
    });
    for (let at = 0; at < argsJson.length; at += CHUNK) {
      send({ tool_calls: [{ index: 0, function: { arguments: argsJson.slice(at, at + CHUNK) } }] });
      await sleep(DELAY);
    }
    send({}, "tool_calls");
    res.write("data: [DONE]\n\n");
    return void res.end();
  }
  send({ content: "wrote it" });
  send({}, "stop");
  res.write("data: [DONE]\n\n");
  res.end();
});
await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));

writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultModel: "mock/wr", compaction: { enabled: false } }));
writeFileSync(
  join(agentDir, "models.json"),
  JSON.stringify({
    providers: {
      mock: {
        baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
        api: "openai-completions",
        apiKey: "test",
        models: [{ id: "wr", name: "Write Mock", contextWindow: 128000, maxTokens: 4096, input: ["text"] }],
      },
    },
  }),
);

const port = 5310;
const bridge = spawn(
  process.execPath,
  [join(ROOT, "bridge", "main.ts"), "--port", String(port), "--session-dir", sessionsDir, "--cwd", workspace, "--no-auto-restart"],
  { stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } },
);
await sleep(3000);

const CDP_PORT = 9262;
const chrome = spawn(
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless=new",
    "--disable-gpu",
    "--disable-extensions",
    "--no-first-run",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${join(root, "chrome")}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);
let cdpUrl;
for (let i = 0; i < 40 && !cdpUrl; i++) {
  try {
    cdpUrl = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).find((t) => t.type === "page")?.webSocketDebuggerUrl;
  } catch {}
  if (!cdpUrl) await sleep(250);
}
const cdp = new WebSocket(cdpUrl, { perMessageDeflate: false });
await new Promise((r, j) => {
  cdp.on("open", r);
  cdp.on("error", j);
});
let msgId = 0;
const pending = new Map();
const errors = [];
cdp.on("message", (d) => {
  const msg = JSON.parse(d.toString());
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
  if (msg.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(msg.params).slice(0, 300));
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    cdp.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (res.result?.exceptionDetails) errors.push(JSON.stringify(res.result.exceptionDetails).slice(0, 300));
  return res.result?.result?.value;
};

const READ = `(() => {
  const card = document.querySelector('.write-card');
  if (!card) return null;
  const bar = card.querySelector('.edit-bar');
  const body = card.querySelector('.edit-diff');
  return {
    cls: card.className,
    bar: bar ? bar.innerText.replace(/\\s+/g, ' ').trim() : '',
    stats: card.querySelector('.edit-stats')?.innerText ?? null,
    size: card.querySelector('.tool-duration')?.innerText ?? null,
    rows: card.querySelectorAll('.diff-line').length,
    lastNum: card.querySelector('.diff-line:last-child .diff-num')?.textContent ?? null,
    highlighted: card.querySelectorAll('.diff-code span[class]').length,
    scrolledToEnd: body ? Math.abs(body.scrollTop + body.clientHeight - body.scrollHeight) < 4 : null,
    bodyH: body ? Math.round(body.getBoundingClientRect().height) : null,
  };
})()`;

try {
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
  await sleep(3500);
  await evaluate("document.querySelector('.sidebar-new-btn').click()");
  await sleep(300);
  await evaluate("document.querySelector('.new-pop-create').click()");
  await sleep(2500);
  await evaluate(`(() => {
    const ta = document.querySelector('textarea');
    ta.value = 'write the file';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(200);
  await evaluate("document.querySelector('.btn-send').click()");
  await evaluate(`(() => {
    window.__frames = [];
    let last = performance.now();
    const step = (now) => {
      window.__frames.push(now - last);
      last = now;
      if (window.__frames.length < 200000) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    return true;
  })()`);

  // Sample the card while the arguments stream.
  const samples = [];
  const start = Date.now();
  while (Date.now() - start < 25000) {
    const state = await evaluate(READ);
    if (state) samples.push({ t: Date.now() - start, ...state });
    if (state?.cls.includes("done")) break;
    await sleep(80);
  }
  const streaming = samples.filter((s) => !s.cls.includes("done"));
  const first = streaming[0];
  const growing = streaming.filter((s, i) => i > 0 && s.rows > streaming[i - 1].rows);
  const pendingLabel = streaming.filter((s) => s.bar.includes("写入中"));
  const late = streaming.at(-1);
  const done = samples.at(-1);

  console.log("samples:", samples.length, "streaming samples:", streaming.length);
  console.log("first streaming sample:", JSON.stringify(first));
  console.log("last streaming sample:", JSON.stringify(late));
  console.log("final:", JSON.stringify(done));

  check("card appears before the call completes", streaming.length > 1, `count=${streaming.length}`);
  check("bar says 写入中… before the path arrives", pendingLabel.length > 0, `samples=${pendingLabel.length}`);
  const withRows = streaming.filter((s) => s.rows > 0);
  check("content shows while streaming", withRows.length > 0, `samples=${withRows.length}/${streaming.length}`);
  check("line count grows during the stream", growing.length >= 5, `growing=${growing.length}`);
  check("stats count up to the written file", done?.stats?.includes(`+${LINES} 行`) === true, JSON.stringify(done?.stats));
  check("body keeps the tail visible while writing", streaming.filter((s) => s.scrolledToEnd).length >= streaming.length - 2,
    `scrolled=${streaming.filter((s) => s.scrolledToEnd).length}/${streaming.length}`);
  check("rows are highlighted from the path's language", (done?.highlighted ?? 0) > 0, `spans=${done?.highlighted}`);
  check("card settles with the path and the size", done?.bar.includes("generated.ts") === true && (done?.size ?? "").includes("KB"),
    JSON.stringify([done?.bar, done?.size]));
  check("all rows rendered at the end", done?.rows === LINES, `rows=${done?.rows}`);
  check("file written to disk", existsSync(join(workspace, "src", "generated.ts")) &&
    readFileSync(join(workspace, "src", "generated.ts"), "utf8") === content);
  const frames = await evaluate(`(() => {
    const f = window.__frames ?? [];
    const sorted = [...f].sort((a, b) => a - b);
    const stalls = f.map((d, i) => ({ i, d: Math.round(d) })).filter((x) => x.d > 100);
    return { n: f.length, max: Math.round(Math.max(...f)), p95: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0), over100: stalls.length, stalls };
  })()`);
  console.log("frames:", JSON.stringify(frames));
  // The last frames carry the tool result and the group collapse, not the stream.
  const streamStalls = (frames?.stalls ?? []).filter((s) => s.i < (frames?.n ?? 0) - 6);
  check("no frame stalls while the content streams", streamStalls.length === 0, JSON.stringify(frames));
  check("no page errors", errors.length === 0, errors.join(" | "));
} finally {
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
  cdp.close();
  chrome.kill();
  bridge.kill();
  mock.close();
  process.exit(failures === 0 ? 0 : 1);
}