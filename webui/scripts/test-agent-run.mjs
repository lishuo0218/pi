// End-to-end run test with a local mock model: a slow streaming turn must
// survive a page reload and a switch to another session, and keep rendering.
// Run npm run build first, then: node scripts/test-agent-run.mjs

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import WebSocket from "ws";

// Run from the repository root regardless of the caller's cwd.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
let failures = 0;
const check = (name, ok, extra = "") => {
  log(ok ? "PASS" : "FAIL", name, extra);
  if (!ok) failures++;
};

const root = mkdtempSync(join(tmpdir(), "pi-run-"));
const agentDir = join(root, "agent");
const sessionsDir = join(root, "sessions");
const workspace = join(root, "ws");
mkdirSync(agentDir, { recursive: true });
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(workspace, { recursive: true });

// Mock OpenAI-compatible endpoint: streams 60 chunks, 200ms apart (~12s).
const MOCK_PORT = 5299;
const CHUNKS = 300;
const mock = http.createServer((req, res) => {
  if (!req.url?.includes("/chat/completions")) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (delta, finish = null) => {
    res.write(
      `data: ${JSON.stringify({
        id: "mock-1",
        object: "chat.completion.chunk",
        created: 0,
        model: "slow",
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`,
    );
  };
  send({ role: "assistant", content: "" });
  let i = 0;
  const timer = setInterval(() => {
    i++;
    send({ content: `w${i} ` });
    if (i >= CHUNKS) {
      clearInterval(timer);
      send({}, "stop");
      res.write("data: [DONE]\n\n");
      res.end();
    }
  }, 200);
  req.on("close", () => clearInterval(timer));
});
await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));

writeFileSync(
  join(agentDir, "settings.json"),
  JSON.stringify({ defaultModel: "mock/slow", compaction: { enabled: false } }),
);
writeFileSync(
  join(agentDir, "models.json"),
  JSON.stringify({
    providers: {
      mock: {
        baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
        api: "openai-completions",
        apiKey: "test",
        models: [{ id: "slow", name: "Slow Mock", contextWindow: 128000, maxTokens: 4096, input: ["text"] }],
      },
    },
  }),
);

const port = 5295;
const bridge = spawn(
  process.execPath,
  [
    join(ROOT, "bridge", "main.ts"),
    "--port",
    String(port),
    "--session-dir",
    sessionsDir,
    "--cwd",
    workspace,
    "--no-auto-restart",
  ],
  {
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
  },
);
await sleep(3000);

const CDP_PORT = 9232;
const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", [
  "--headless=new",
  "--disable-gpu",
  "--disable-extensions",
  "--no-first-run",
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${join(root, "chrome")}`,
  "about:blank",
], { stdio: "ignore" });
let cdpUrl;
for (let i = 0; i < 40 && !cdpUrl; i++) {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
    cdpUrl = targets.find((t) => t.type === "page")?.webSocketDebuggerUrl;
  } catch {}
  if (!cdpUrl) await sleep(250);
}
if (!cdpUrl) throw new Error("no CDP target");
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
const bodyText = () => evaluate("document.body.innerText");
const isRunning = () => evaluate("!!document.querySelector('.btn-stop')");
const transcript = () =>
  evaluate("[...document.querySelectorAll('.msg-assistant .md-body')].map(e=>e.innerText).join('')");
const waitFor = async (fn, timeoutMs, label) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await sleep(200);
  }
  log("timeout waiting for", label);
  return false;
};

try {
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
  await sleep(3500);
  check("page hydrated", !!(await evaluate("document.querySelector('textarea')")));

  // New session in the dialog = its own runtime; page should stay attached.
  await evaluate("document.querySelector('.sidebar-new-btn').click()");
  await sleep(300);
  await evaluate("document.querySelector('.new-pop-create').click()");
  await sleep(2500);
  check("new session created", !(await bodyText()).includes("新建会话失败"));

  // Start a slow streaming turn, then reload the page mid-stream.
  await evaluate(`(() => {
    const ta = document.querySelector('textarea');
    ta.value = 'hello';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(200);
  await evaluate("document.querySelector('.btn-send').click()");
  const running = await waitFor(isRunning, 15000, "run start");
  check("run started", running);
  await sleep(3000);
  const beforeReload = await transcript();
  check("streaming text is rendering", beforeReload.length > 5, JSON.stringify(beforeReload.slice(0, 40)));

  await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
  await sleep(3500);
  const runningAfterReload = await isRunning();
  const textAfterReload = await transcript();
  check("reload restores the running state", runningAfterReload);
  check(
    "reload restores the partial answer",
    textAfterReload.includes(beforeReload.slice(0, 10)),
    JSON.stringify(textAfterReload.slice(0, 40)),
  );
  await sleep(2000);
  const grownAfterReload = await transcript();
  check("stream continues after reload", grownAfterReload.length > textAfterReload.length, `${textAfterReload.length} -> ${grownAfterReload.length}`);

  // Switch to another session while it runs, then come back.
  await evaluate("document.querySelector('.sidebar-new-btn').click()");
  await sleep(300);
  await evaluate("document.querySelector('.new-pop-create').click()");
  await sleep(2500);
  const runInOther = await isRunning();
  check("other session is not running", !runInOther);
  check(
    "background run shows a badge on its session card",
    !!(await evaluate("document.querySelector('.session-card:not(.current) .session-run-badge')")),
  );
  const otherText = await transcript();

  await evaluate(
    "[...document.querySelectorAll('.session-card')].find(e=>!e.classList.contains('current')).click()",
  );
  await sleep(2500);
  const backText = await transcript();
  const backRunning = await isRunning();
  check("switched back to the running session", backText.length > otherText.length, `${otherText.length} vs ${backText.length}`);
  check("switched-back session still running", backRunning);
  await sleep(2500);
  const finalText = await transcript();
  check("stream kept running while detached", finalText.length > backText.length, `${backText.length} -> ${finalText.length}`);
  check("no page exceptions", errors.length === 0, errors.join(" | "));
} finally {
  log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
  cdp.close();
  chrome.kill();
  bridge.kill("SIGTERM");
  mock.close();
  await sleep(800);
  process.exit(failures === 0 ? 0 : 1);
}