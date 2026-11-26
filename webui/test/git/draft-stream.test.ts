// The AI draft endpoint: frames reach the page while the model writes, a
// repository that cannot be resolved answers with one error frame, and an
// aborted request stops the run instead of leaving pi behind.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { handleGitDraftStream } from "../../bridge/git/draft.ts";
import { cleanupAll, git, makeDir, makeRepo, write, type Fixture } from "./helpers.ts";

const fixtures: Fixture[] = [];

afterAll(() => cleanupAll(fixtures));

type Serving = { url: string; close: () => Promise<void> };

/** Serve the draft endpoint for one fixture directory and pi stub. */
async function serve(cwd: string, piPath: string): Promise<Serving> {
  const server = createServer((request, response) => handleGitDraftStream(request, response, cwd, piPath));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function stubPi(body: string): Promise<string> {
  const dir = await makeDir();
  fixtures.push(dir);
  const path = join(dir.dir, "fake-pi.mjs");
  await writeFile(path, body, "utf-8");
  return path;
}

/** Repository with one staged file, ready for a draft. */
async function stagedRepo(): Promise<Fixture> {
  const repo = await makeRepo();
  fixtures.push(repo);
  await write(repo.dir, "a.txt", "one\n");
  await git(repo.dir, ["add", "-A"]);
  return repo;
}

describe("POST /api/git/draft", () => {
  it("streams snapshots and ends with the finished message", async () => {
    const repo = await stagedRepo();
    const piPath = await stubPi(
      [
        'const send = (delta) => process.stdout.write(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } }) + "\\n");',
        'send("feat: ");',
        "setTimeout(() => send(\"stream the message\"), 20);",
      ].join("\n"),
    );
    const serving = await serve(repo.dir, piPath);
    try {
      const res = await fetch(`${serving.url}/api/git/draft`, { method: "POST" });
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const body = await res.text();
      const frames = body
        .split("\n\n")
        .filter((part) => part !== "")
        .map((part) => JSON.parse(part.replace(/^data: /, "")));
      expect(frames).toEqual([
        { type: "snapshot", text: "feat:" },
        { type: "snapshot", text: "feat: stream the message" },
        { type: "done", message: "feat: stream the message" },
      ]);
    } finally {
      await serving.close();
    }
  });

  it("answers with one error frame when there is no repository", async () => {
    const dir = await makeDir();
    fixtures.push(dir);
    const piPath = await stubPi('process.stdout.write("should not run\\n");\n');
    const serving = await serve(dir.dir, piPath);
    try {
      const body = await (await fetch(`${serving.url}/api/git/draft`, { method: "POST" })).text();
      expect(JSON.parse(body.replace(/^data: /, "").trim())).toMatchObject({ type: "error", code: "not-a-repo" });
    } finally {
      await serving.close();
    }
  });

  it("stops the run when the page aborts the request", async () => {
    const repo = await stagedRepo();
    // The stub keeps writing: an aborted request must close the stream instead
    // of waiting out the deadline.
    const piPath = await stubPi(
      [
        'const send = (delta) => process.stdout.write(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } }) + "\\n");',
        'send("feat: first");',
        'setInterval(() => send(" still writing"), 20);',
      ].join("\n"),
    );
    const serving = await serve(repo.dir, piPath);
    try {
      const controller = new AbortController();
      const res = await fetch(`${serving.url}/api/git/draft`, { method: "POST", signal: controller.signal });
      const reader = res.body?.getReader();
      if (reader === undefined) throw new Error("no stream body");
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain('"snapshot"');
      controller.abort();
      await expect(reader.read()).rejects.toThrow();
    } finally {
      await serving.close();
    }
  });
});