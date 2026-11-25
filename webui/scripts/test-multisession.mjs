// End-to-end check of per-session runtimes: a bash run in session A must keep
// going while the bridge is attached to session B, and attaching back to A must
// find it alive (no switch_session abort, no restart).
// Run: node scripts/test-multisession.mjs (needs no build; the bridge runs from source)

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

// Run from the repository root regardless of the caller's cwd.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
let failures = 0;
const check = (name, ok, extra) => {
  log(ok ? "PASS" : "FAIL", name, extra ?? "");
  if (!ok) failures++;
};

const root = mkdtempSync(join(tmpdir(), "pi-multi-"));
const workspace = join(root, "ws");
const sessionsDir = join(root, "sessions");
const seedDir = join(sessionsDir, "--seed--");
mkdirSync(workspace, { recursive: true });
mkdirSync(seedDir, { recursive: true });

// Two real session files, copied so the originals stay untouched.
const seedRoot = join(homedir(), ".pi", "agent", "sessions");
const candidates = readdirSync(seedRoot, { recursive: true })
  .filter((p) => String(p).endsWith(".jsonl"))
  .slice(0, 3)
  .map((p) => join(seedRoot, String(p)));
const paths = candidates.map((src, i) => {
  const target = join(seedDir, `seed${i}.jsonl`);
  copyFileSync(src, target);
  return target;
});
log("seeded", paths.length, "sessions");

const port = 5297;
const bridge = spawn(
  process.execPath,
  [join(ROOT, "bridge", "main.ts"), "--port", String(port), "--session-dir", sessionsDir, "--no-auto-restart"],
  { stdio: ["ignore", "inherit", "inherit"] },
);

await sleep(2500);
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
const pending = new Map();
const notices = [];
ws.on("message", (d) => {
  const rec = JSON.parse(String(d));
  if (rec.type === "response" && pending.has(rec.id)) {
    pending.get(rec.id)(rec);
    pending.delete(rec.id);
    return;
  }
  if (rec.type === "bridge_notice" && rec.notice === "runtimes") notices.push(rec.runtimes);
  if (rec.type === "pi_exited" || rec.type === "pi_error" || rec.type === "bridge_error") {
    log("!!", rec.type, JSON.stringify(rec).slice(0, 200));
  }
});
await new Promise((r) => ws.on("open", r));
const cmd = (record, timeout = 20000) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(record.id);
      resolve({ success: false, error: "timeout" });
    }, timeout);
    pending.set(record.id, (rec) => {
      clearTimeout(timer);
      resolve(rec);
    });
    ws.send(JSON.stringify(record));
  });

const ticks = join(workspace, "ticks.txt");
const ticksArg = ticks.split(String.fromCharCode(92)).join("/");
const tickLines = () => (existsSync(ticks) ? readFileSync(ticks, "utf8").trim().split("\n").filter(Boolean).length : 0);

try {
  const [a, b, c] = paths;
  const attA = await cmd({ type: "bridge_attach", id: "a1", sessionPath: a });
  check("attach A", attA.success, JSON.stringify(attA).slice(0, 160));
  log("runtimes", JSON.stringify(notices.at(-1)));
  const stA = await cmd({ type: "get_state", id: "s1" });
  log("A state", JSON.stringify(stA.data));
  check("A resumed from file", stA.data?.sessionFile?.replace(/\\/g, "/").endsWith("seed0.jsonl"), stA.data?.sessionFile);

  const bashId = "bash-A";
  void cmd({ type: "bash", id: bashId, command: `for i in $(seq 1 20); do echo tick$i >> "${ticksArg}"; sleep 1; done` }, 60000);
  await sleep(2500);
  const before = tickLines();
  check("A bash is running", before >= 2, `lines=${before}`);

  const attB = await cmd({ type: "bridge_attach", id: "a2", sessionPath: b });
  check("attach B", attB.success, JSON.stringify(attB).slice(0, 160));
  const stB = await cmd({ type: "get_state", id: "s2" });
  check("B is its own session", stB.data?.sessionFile?.replace(/\\/g, "/").endsWith("seed1.jsonl"), stB.data?.sessionFile);
  log("runtimes", JSON.stringify(notices.at(-1)));

  const midway = tickLines();
  await sleep(4000);
  const after = tickLines();
  check("A's bash kept running while B was attached", after > midway && after > before, `${before} -> ${midway} -> ${after}`);

  const attA2 = await cmd({ type: "bridge_attach", id: "a3", sessionPath: a });
  check("re-attach A", attA2.success);
  const aTicks = tickLines();
  await sleep(2500);
  check("A still the same live runtime", tickLines() > aTicks, `${aTicks} -> ${tickLines()}`);
  const stA2 = await cmd({ type: "get_state", id: "s3" });
  log("A state again", JSON.stringify(stA2.data));

  // Delete path: the runtime must be stopped so Windows can unlink the file.
  const attC = await cmd({ type: "bridge_attach", id: "a4", sessionPath: c });
  check("attach C", attC.success);
  const del = await cmd({ type: "bridge_delete_session", id: "d1", path: c });
  check("delete C", del.success, JSON.stringify(del).slice(0, 160));
  await sleep(500);
  check("C file is gone", !existsSync(c));
  log("runtimes", JSON.stringify(notices.at(-1)));
} finally {
  log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
  ws.close();
  bridge.kill("SIGTERM");
  await sleep(800);
  process.exit(failures === 0 ? 0 : 1);
}