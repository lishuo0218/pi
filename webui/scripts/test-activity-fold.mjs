// End-to-end fold test with a local mock model: a turn that thinks, runs bash
// and then answers must keep one activity group expanded while it runs (with the
// bash card inside it) and collapse it once the turn settles.
// Run npm run build first, then: node scripts/test-activity-fold.mjs
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

const root = mkdtempSync(join(tmpdir(), "pi-live-"));
const agentDir = join(root, "agent");
const sessionsDir = join(root, "sessions");
const workspace = join(root, "ws");
mkdirSync(agentDir, { recursive: true });
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(workspace, { recursive: true });

// Mock model: the first call thinks and asks for a bash command, the second answers.
const MOCK_PORT = 5297;
let calls = 0;
const mock = http.createServer(async (req, res) => {
  if (!req.url?.includes("/chat/completions")) {
    res.writeHead(404).end();
    return;
  }
  calls++;
  const call = calls;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (delta, finish = null) =>
    res.write(
      `data: ${JSON.stringify({
        id: `mock-${call}`,
        object: "chat.completion.chunk",
        created: 0,
        model: "fold",
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`,
    );
  req.on("error", () => {});
  res.on("error", () => {});
  send({ role: "assistant", content: "" });
  if (call === 1) {
    // Slow thinking, then a slow bash call: a long window in which the group is
    // the live one, so the probe can observe it.
    await sleep(300);
    send({ reasoning_content: "先看看目录。" });
    await sleep(2500);
    send({
      tool_calls: [
        { index: 0, id: "call_bash_1", type: "function", function: { name: "bash", arguments: "" } },
      ],
    });
    await sleep(100);
    send({ tool_calls: [{ index: 0, function: { arguments: '{"command":"sleep 1; echo live-fold"}' } }] });
    send({}, "tool_calls");
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }
  // Answer only after a pause, so the group stays live a while longer.
  await sleep(2000);
  for (let i = 1; i <= 5; i++) {
    send({ content: `done${i} ` });
    await sleep(100);
  }
  send({}, "stop");
  res.write("data: [DONE]\n\n");
  res.end();
});
await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));

writeFileSync(
  join(agentDir, "settings.json"),
  JSON.stringify({ defaultModel: "mock/fold", compaction: { enabled: false } }),
);
writeFileSync(
  join(agentDir, "models.json"),
  JSON.stringify({
    providers: {
      mock: {
        baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
        api: "openai-completions",
        apiKey: "test",
        models: [
          {
            id: "fold",
            name: "Fold Mock",
            contextWindow: 128000,
            maxTokens: 4096,
            reasoning: true,
            input: ["text"],
          },
        ],
      },
    },
  }),
);

const port = 5296;
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
  { stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } },
);
await sleep(3000);

const CDP_PORT = 9237;
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
    const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
    cdpUrl = targets.find((t) => t.type === "page")?.webSocketDebuggerUrl;
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
const heads = () => evaluate("[...document.querySelectorAll('.activity-head')].map((e) => e.innerText)");
const waitFor = async (fn, timeoutMs, label) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await sleep(200);
  }
  console.log("timeout waiting for", label);
  return false;
};

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
    ta.value = 'run it';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(200);
  await evaluate("document.querySelector('.btn-send').click()");

  const sawLive = await waitFor(
    async () => (await evaluate("!!document.querySelector('.activity.live.open')")),
    30000,
    "live open group",
  );
  check("running turn auto-expands its group", sawLive, JSON.stringify(await heads()));
  const tailText = await evaluate("document.querySelector('.activity.live .running-line')?.innerText");
  check("running line sits under the group", (tailText ?? "").includes("运行中"), tailText);
  await waitFor(
    async () => ((await evaluate("document.querySelector('.activity.live .activity-head')?.innerText")) ?? "").includes("执行"),
    15000,
    "bash segment in the live group",
  );
  const liveText = await evaluate("document.querySelector('.activity.live .activity-head')?.innerText");
  check("live header counts thinking and commands", /已思考 1 次/.test(liveText ?? "") && /执行 1 条命令/.test(liveText ?? ""), liveText);
  await waitFor(
    async () => (await evaluate("document.querySelectorAll('.activity.open .activity-body .bash-card').length")) === 1,
    15000,
    "bash card inside the live group",
  );
  const cardInside = await evaluate("document.querySelectorAll('.activity.open .activity-body .bash-card').length");
  check("expanded group holds the bash card", cardInside === 1, `cards=${cardInside}`);

  const settled = await waitFor(
    async () => !(await evaluate("!!document.querySelector('.btn-stop')")),
    40000,
    "turn settle",
  );
  check("turn settled", settled);
  await sleep(800);
  const openAfter = await evaluate("document.querySelectorAll('.activity.open').length");
  const liveAfter = await evaluate("document.querySelectorAll('.activity.live').length");
  console.log("after settle heads:", JSON.stringify(await heads()));
  check("group collapses when the turn ends", openAfter === 0, `open=${openAfter}`);
  check("no group stays live", liveAfter === 0, `live=${liveAfter}`);
  const answer = await evaluate("[...document.querySelectorAll('.md-body')].map((e) => e.innerText).join('|')");
  check("answer text still renders", answer.includes("done1"), answer.slice(0, 80));
  const bodyInStream = await evaluate("document.querySelectorAll('.msg-assistant > .bash-card').length");
  check("no bash card left outside a group", bodyInStream === 0, `outside=${bodyInStream}`);

  // A manual click must survive the turn ending.
  await evaluate("document.querySelector('.activity:not(.open) .activity-head').click()");
  await sleep(200);
  const manualOpen = await evaluate("document.querySelectorAll('.activity.open').length");
  check("a history group opens on click", manualOpen === 1, `open=${manualOpen}`);

  // The body must grow over several frames, not jump: the grid row animates
  // and the shut body is clipped by `.collapse-inner`.
  const growing = await evaluate(`(async () => {
    document.querySelector('.activity.open .activity-head').click();
    await new Promise((r) => setTimeout(r, 250));
    const head = document.querySelector('.activity-head');
    const heights = [];
    const t0 = performance.now();
    head.click();
    while (performance.now() - t0 < 400) {
      const body = document.querySelector('.activity .collapse');
      heights.push(body ? Math.round(body.getBoundingClientRect().height) : -1);
      await new Promise((r) => requestAnimationFrame(r));
    }
    return heights;
  })()`);
  const tallest = Math.max(...growing);
  const animated = growing.filter((h) => h > 0 && h < tallest).length;
  check("expanding animates the height", animated >= 2, `frames=${growing.length} mid=${animated} top=${tallest}`);
  check("no page exceptions", errors.length === 0, errors.join(" | "));
} finally {
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
  cdp.close();
  chrome.kill();
  bridge.kill();
  mock.close();
}