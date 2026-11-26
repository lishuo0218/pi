// The page side of the AI draft stream: frames are parsed as they arrive, even
// when a chunk boundary cuts one in half, and an error frame ends the run as a
// failed reply rather than a message.
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamGitDraft } from "../../src/git/api.ts";

/** Replace fetch with a body that yields these chunks, split as written. */
function stubStream(chunks: string[]): void {
  const encoder = new TextEncoder();
  vi.stubGlobal("fetch", () =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
          },
        }),
        { status: 200 },
      ),
    ),
  );
}

const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("streamGitDraft", () => {
  it("reports each snapshot and returns the finished message", async () => {
    stubStream([
      frame({ type: "snapshot", text: "feat:" }),
      frame({ type: "snapshot", text: "feat: stream" }),
      frame({ type: "done", message: "feat: stream it" }),
    ]);
    const seen: string[] = [];
    const result = await streamGitDraft({ onSnapshot: (text) => seen.push(text), signal: new AbortController().signal });
    expect(seen).toEqual(["feat:", "feat: stream"]);
    expect(result).toEqual({ ok: true, action: "message", message: "feat: stream it" });
  });

  it("parses a frame that a chunk boundary cut in half", async () => {
    const whole = frame({ type: "snapshot", text: "fix: split" });
    stubStream([whole.slice(0, 12), whole.slice(12), frame({ type: "done", message: "fix: split" })]);
    const seen: string[] = [];
    const result = await streamGitDraft({ onSnapshot: (text) => seen.push(text), signal: new AbortController().signal });
    expect(seen).toEqual(["fix: split"]);
    expect(result).toMatchObject({ ok: true, message: "fix: split" });
  });

  it("ignores keep-alives and ends with the bridge's error", async () => {
    stubStream([": ping\n\n", frame({ type: "error", error: "没有可提交的改动", code: "failed" })]);
    const result = await streamGitDraft({ onSnapshot: () => {}, signal: new AbortController().signal });
    expect(result).toEqual({ ok: false, error: "没有可提交的改动", code: "failed" });
  });

  it("reports a stream that stops without a final frame", async () => {
    stubStream([frame({ type: "snapshot", text: "feat: half" })]);
    const result = await streamGitDraft({ onSnapshot: () => {}, signal: new AbortController().signal });
    expect(result).toEqual({ ok: false, error: "生成中断", code: "failed" });
  });
});