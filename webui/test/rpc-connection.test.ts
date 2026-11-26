// Browser-side RPC client: response correlation, failed-but-resolved error
// paths (disconnect, deadline), verbatim sends for extension ui replies, and
// the state change a reopened socket reports.
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { RpcConnection } from "../src/rpc-connection.ts";

const servers: WebSocketServer[] = [];
const connections: RpcConnection[] = [];

afterEach(() => {
  for (const conn of connections.splice(0)) conn.close();
  for (const server of servers.splice(0)) server.close();
});

/** A bridge stand-in on an ephemeral port; `onCommand` sees each parsed record. */
async function serve(onCommand: (record: Record<string, unknown>, ws: ServerSocket) => void) {
  const server = new WebSocketServer({ port: 0 });
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const sockets: ServerSocket[] = [];
  server.on("connection", (ws) => {
    sockets.push(ws);
    ws.on("message", (data) => onCommand(JSON.parse(String(data)) as Record<string, unknown>, ws));
  });
  const port = (server.address() as { port: number }).port;
  return { url: `ws://127.0.0.1:${port}/ws`, sockets };
}

function connect(url: string, timeoutMs?: number): RpcConnection {
  const conn = new RpcConnection({ timeoutMs });
  connections.push(conn);
  conn.connect(url);
  return conn;
}

async function opened(conn: RpcConnection): Promise<void> {
  await new Promise<void>((resolve) => {
    if (conn.state === "open") return resolve();
    conn.onState((state) => {
      if (state === "open") resolve();
    });
  });
}

describe("RpcConnection", () => {
  it("resolves a command with the response carrying its id", async () => {
    const { url } = await serve((record, ws) => {
      ws.send(JSON.stringify({ type: "response", command: record.type, id: record.id, success: true }));
    });
    const conn = connect(url);
    await opened(conn);
    const res = await conn.command({ type: "get_state" });
    expect(res.success).toBe(true);
    expect(res.command).toBe("get_state");
  });

  it("resolves pending commands as failed when the socket closes", async () => {
    const { url, sockets } = await serve(() => {
      // Never answers; the close below is the only completion.
    });
    const conn = connect(url);
    await opened(conn);
    const pending = conn.command({ type: "get_state" });
    sockets[0]?.close();
    const res = await pending;
    expect(res.success).toBe(false);
    expect(res.error).toBe("连接已断开");
  });

  it("fails a command that never answers instead of hanging", async () => {
    const { url } = await serve(() => {});
    const conn = connect(url, 50);
    await opened(conn);
    const pending = conn.command({ type: "get_state" });
    const res = await pending;
    expect(res.success).toBe(false);
    expect(res.error).toContain("超时");
  });

  it("fails immediately when the socket is not open", async () => {
    const conn = new RpcConnection();
    connections.push(conn);
    const res = await conn.command({ type: "get_state" });
    expect(res.success).toBe(false);
    expect(res.error).toBe("连接已断开");
  });

  it("sends an extension ui reply verbatim, keeping its request id", async () => {
    const seen: Record<string, unknown>[] = [];
    const { url } = await serve((record) => seen.push(record));
    const conn = connect(url);
    await opened(conn);
    conn.send({ type: "extension_ui_response", id: "req-1", value: "yes" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen).toEqual([{ type: "extension_ui_response", id: "req-1", value: "yes" }]);
  });

  it("reports closed then open again after a reconnect", async () => {
    const { url, sockets } = await serve(() => {});
    const conn = connect(url);
    const states: string[] = [];
    conn.onState((state) => states.push(state));
    await opened(conn);
    sockets[0]?.close();
    await new Promise<void>((resolve) => {
      conn.onState((state) => {
        if (state === "open") resolve();
      });
    });
    expect(states).toEqual(["open", "closed", "connecting", "open"]);
  });
});