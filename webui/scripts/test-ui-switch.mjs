// CDP smoke test: sidebar session switching must reuse per-session runtimes
// (bridge_attach), keep the UI attached, and show no pi-exited / error banner.
// Run npm run build first, then: node scripts/test-ui-switch.mjs

import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

const root = mkdtempSync(join(tmpdir(), "pi-ui-"));
const sessionsRoot = join(root, "sessions");
const seedRoot = join(homedir(), ".pi", "agent", "sessions");
// A custom --session-dir holds sessions flat: the sidebar shows one group.
const group = readdirSync(seedRoot, { withFileTypes: true }).find((d) => d.isDirectory());
if (!group) throw new Error("no seed group");
const srcFiles = readdirSync(join(seedRoot, group.name))
  .filter((f) => f.endsWith(".jsonl"))
  .slice(0, 3);
mkdirSync(sessionsRoot, { recursive: true });
for (const f of srcFiles) copyFileSync(join(seedRoot, group.name, f), join(sessionsRoot, f));
log("seeded", srcFiles.length, "sessions in", sessionsRoot);

const port = 5196;
const bridge = spawn(
  process.execPath,
  [join(ROOT, "bridge", "main.ts"), "--port", String(port), "--session-dir", sessionsRoot, "--no-auto-restart"],
  { stdio: ["ignore", "ignore", "inherit"] },
);
await sleep(2500);

const CDP_PORT = 9231;
const profile = join(root, "chrome");
const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", [
  "--headless=new",
  "--disable-gpu",
  "--disable-extensions",
  "--no-first-run",
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${profile}`,
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
const consoleErrors = [];
cdp.on("message", (d) => {
  const msg = JSON.parse(d.toString());
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
  if (msg.method === "Runtime.exceptionThrown") {
    consoleErrors.push(JSON.stringify(msg.params).slice(0, 200));
  }
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    cdp.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return res.result?.result?.value;
};

try {
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
  await sleep(3000);

  log("panel:", JSON.stringify(await evaluate("document.querySelector('.panel-list')?.innerText")));
  log("groups:", JSON.stringify(await evaluate("document.querySelector('.group-card')?.outerHTML?.slice(0,400)")));
  const cards = await evaluate("document.querySelectorAll('.session-card').length");
  check("sidebar lists the seeded sessions", cards >= 2, `cards=${cards}`);
  const connected = await evaluate("document.body.innerText.includes('已连接')");
  check("ws connected", !!connected);

  const text1 = await evaluate("document.body.innerText");
  await evaluate("document.querySelectorAll('.session-card')[0].click()");
  await sleep(1500);
  const afterFirst = await evaluate("document.body.innerText");
  const currentIdx1 = await evaluate(
    "[...document.querySelectorAll('.session-card')].findIndex((e) => e.classList.contains('current'))",
  );
  log("current card index after click 1:", currentIdx1);

  await evaluate("document.querySelectorAll('.session-card')[1].click()");
  await sleep(1500);
  const afterSecond = await evaluate("document.body.innerText");
  const currentIdx2 = await evaluate(
    "[...document.querySelectorAll('.session-card')].findIndex((e) => e.classList.contains('current'))",
  );
  log("current card index after click 2:", currentIdx2);
  check("switching moved the current session", currentIdx1 !== currentIdx2, `${currentIdx1} -> ${currentIdx2}`);
  check("conversation content changed", afterFirst !== afterSecond);

  await evaluate("document.querySelectorAll('.session-card')[0].click()");
  await sleep(1500);
  const back = await evaluate("document.body.innerText");
  check("switching back shows the first conversation again", back === afterFirst);

  for (const bad of ["pi 已退出", "恢复会话失败", "切换会话失败", "已断开"]) {
    check(`no "${bad}" banner`, !back.includes(bad));
  }
  check("no page exceptions", consoleErrors.length === 0, consoleErrors.join(" | "));
  log("pi version line:", (back.match(/pi[^\n]*v?1\.6\.0/) ?? [""])[0]);
  void text1;
} finally {
  log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
  cdp.close();
  chrome.kill();
  bridge.kill("SIGTERM");
  await sleep(800);
  process.exit(failures === 0 ? 0 : 1);
}