// The change stream over a real HTTP server: SSE headers, the initial `ready`
// frame, `change` after a commit, and `unavailable` when there is no repository.
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { handleGitEvents } from "../../bridge/git/events.ts";
import { cleanupAll, commitAll, makeDir, makeRepo, write, type Fixture } from "./helpers.ts";

const fixtures: Fixture[] = [];
const servers: Server[] = [];
const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];

afterEach(async () => {
  for (const reader of readers.splice(0)) await reader.cancel();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
  await cleanupAll(fixtures);
});

/** Serve the handler and return the open response's body reader. */
async function connect(cwd: string): Promise<{ response: Response; reader: ReadableStreamDefaultReader<Uint8Array> }> {
  const server = createServer((request, response) => handleGitEvents(request, response, cwd));
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}/api/git/events`);
  const body = response.body;
  if (body === null) throw new Error("no stream body");
  const reader = body.getReader();
  readers.push(reader);
  return { response, reader };
}

/** Read frames until `until` matches the accumulated text, or time out. */
async function collect(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  until: (text: string) => boolean,
  timeoutMs = 10_000,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;
  while (!until(text)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`timed out, received: ${text}`);
    let timer: NodeJS.Timeout | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out, received: ${text}`)), remaining);
    });
    try {
      const next = await Promise.race([reader.read(), timeout]);
      if (next.done) break;
      text += decoder.decode(next.value, { stream: true });
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }
  return text;
}

describe("git change stream", () => {
  it("opens an event stream and announces the repository", async () => {
    const fixture = await makeRepo();
    fixtures.push(fixture);
    const { response, reader } = await connect(fixture.dir);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("no-cache");
    const text = await collect(reader, (all) => all.includes("event: ready"));
    expect(text).toContain("retry: 3000");
    expect(text).toContain(`"root":`);
  });

  it("pushes a change frame after a commit", async () => {
    const fixture = await makeRepo();
    fixtures.push(fixture);
    const { reader } = await connect(fixture.dir);
    await collect(reader, (all) => all.includes("event: ready"));

    await write(fixture.dir, "a.txt", "one\n");
    await commitAll(fixture.dir, "add a");
    const text = await collect(reader, (all) => all.includes("event: change"));
    expect(text).toContain("event: change");
  });

  it("reports a missing repository and ends the stream", async () => {
    const fixture = await makeDir();
    fixtures.push(fixture);
    const { reader } = await connect(fixture.dir);
    const text = await collect(reader, (all) => all.includes("event: unavailable"));
    expect(text).toContain("not a git repository");
    const rest = await reader.read();
    expect(rest.done).toBe(true);
  });
});