// Production entry: serve the built frontend via the bridge on one port.
// Usage: node scripts/start.mjs [--port N] [--pi-path PATH] [--cwd DIR]
// --pi-path accepts an executable, a .cmd/.bat shim, or a local pi entry file
// (.js/.mjs), which the bridge runs with its own node binary. Defaults to this
// repo's pi build (packages/coding-agent/dist/bundle/cli.js), else pi on PATH.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const child = spawn(process.execPath, [join(root, "bridge", "main.ts"), ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: root,
});
child.on("exit", (code) => process.exit(code ?? 0));
