// Bridge CLI entry: start the pi subprocess + HTTP/WS bridge server.
// Usage: node dist-bridge/bridge.mjs [--port N] [--pi-path PATH] [--cwd DIR] [--no-session]
// --pi-path defaults to this repo's pi build when present, else pi on PATH.
import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startBridge } from "./server.ts";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Default pi binary: the build in this repo when it exists, so the web UI runs
 * the same tools as the checkout, otherwise the pi installed on PATH.
 */
function defaultPiPath(): string {
  const localBuild = join(here, "..", "..", "packages", "coding-agent", "dist", "bundle", "cli.js");
  if (existsSync(localBuild)) return localBuild;
  return process.platform === "win32" ? "pi.cmd" : "pi";
}

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "5173" },
    host: { type: "string", default: "127.0.0.1" },
    "pi-path": { type: "string", default: defaultPiPath() },
    cwd: { type: "string", default: process.cwd() },
    "static-root": { type: "string" },
    "session-dir": { type: "string" },
    "no-session": { type: "boolean", default: false },
    "no-auto-restart": { type: "boolean", default: false },
    token: { type: "string" },
  },
});

const extraArgs = [
  ...(values["no-session"] ? ["--no-session"] : []),
  ...(values["session-dir"] ? ["--session-dir", values["session-dir"]] : []),
];
const staticRoot = values["static-root"] ?? join(here, "..", "dist");

const handle = await startBridge({
  port: Number(values.port),
  host: values.host,
  piPath: values["pi-path"],
  cwd: values.cwd,
  staticRoot,
  piExtraArgs: extraArgs,
  autoRestart: !values["no-auto-restart"],
  token: values.token,
  sessionDir: values["session-dir"],
});

console.log(`pi-web bridge:`);
console.log(`  http://${values.host}:${handle.port}  (static: ${staticRoot})`);
console.log(`  pi: ${values["pi-path"]}${handle.piVersion ? ` @ ${handle.piVersion}` : " (version unknown)"}`);
console.log(`  cwd: ${values.cwd}`);
console.log(`  auto-restart: ${values["no-auto-restart"] ? "off" : "on"}`);
if (values.token) console.log(`  token: enabled`);

const shutdown = () => {
  handle.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
