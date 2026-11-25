// Dev orchestrator: run the bridge (via tsx-free strip-types path) and the
// Vite dev server together. Vite proxies /ws to the bridge.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Dev layout: Vite serves the page on 5173 and proxies /ws to the bridge,
// so the bridge must listen on a second port. Default it to 5174, matching
// the vite.config proxy target; an explicit user --port still wins (keep
// the proxy target in sync in that case).
const userArgs = process.argv.slice(2);
const bridgeArgs = userArgs.some((a) => a === "--port") ? userArgs : ["--port", "5174", ...userArgs];

const bridge = spawn(
  process.execPath,
  [join(root, "bridge", "main.ts"), ...bridgeArgs],
  { stdio: "inherit", cwd: root },
);

// strictPort: fail fast on 5173 being taken instead of silently moving the
// browser to another URL the /ws proxy was not configured for.
const vite = spawn(
  process.execPath,
  [join(root, "node_modules", "vite", "bin", "vite.js"), "--port", "5173", "--strictPort"],
  { stdio: "inherit", cwd: root },
);

const stop = () => {
  bridge.kill();
  vite.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
bridge.on("exit", () => vite.kill());
vite.on("exit", () => bridge.kill());
