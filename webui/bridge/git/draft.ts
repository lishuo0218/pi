// POST /api/git/draft: the AI commit message as server-sent events, so the
// commit box fills while the model writes. One request owns one pi process;
// closing the request (the page's Stop button aborts the fetch) kills it and
// the text written so far stays in the box.
import type { IncomingMessage, ServerResponse } from "node:http";
import { draftCommitMessage } from "./message.ts";
import { resolveRepo } from "./repo.ts";
import type { GitErrorCode } from "./types.ts";

/** One frame of the stream; the page parses the same shape. */
type DraftFrame =
  | { type: "snapshot"; text: string }
  | { type: "done"; message: string }
  | { type: "error"; error: string; code: GitErrorCode };

/** POST /api/git/draft: `snapshot` frames, then one `done` or `error` frame. */
export function handleGitDraftStream(
  _request: IncomingMessage,
  response: ServerResponse,
  cwd: string,
  piPath: string,
): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    // Ask proxies (Vite's dev proxy included) not to buffer the stream.
    "x-accel-buffering": "no",
  });
  // A closed request cannot be written to, and the model run has no reader
  // left: abort so the child dies instead of running to its deadline.
  const controller = new AbortController();
  let closed = false;
  const send = (frame: DraftFrame): void => {
    if (!closed) response.write(`data: ${JSON.stringify(frame)}\n\n`);
  };
  response.on("close", () => {
    closed = true;
    controller.abort();
  });
  void (async () => {
    const resolution = await resolveRepo(cwd);
    if (resolution.kind === "error") {
      send({ type: "error", error: resolution.error, code: resolution.code });
      response.end();
      return;
    }
    const result = await draftCommitMessage(resolution.repo, piPath, {
      signal: controller.signal,
      onSnapshot: (text) => send({ type: "snapshot", text }),
    });
    if (closed) return;
    if (result.ok && result.action === "message") {
      send({ type: "done", message: result.message });
    } else if (result.ok) {
      send({ type: "error", error: "生成结果无效", code: "failed" });
    } else {
      send({ type: "error", error: result.error, code: result.code });
    }
    response.end();
  })();
}