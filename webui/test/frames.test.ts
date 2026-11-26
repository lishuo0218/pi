// Framing and trust-boundary tests: JSONL split on LF only with the bytes of a
// multi-byte character assembled across chunks, and the origin gate that keeps
// a page from the internet out of the local agent.
import { describe, expect, it } from "vitest";
import { FrameDecoder } from "../bridge/frames.ts";
import { checkOrigin } from "../bridge/origin.ts";

function decode(chunks: Buffer[]): string[] {
  const lines: string[] = [];
  const decoder = new FrameDecoder((line) => lines.push(line));
  for (const chunk of chunks) decoder.push(chunk);
  decoder.end();
  return lines;
}

describe("FrameDecoder", () => {
  it("reassembles a multi-byte character split across chunks", () => {
    // "你世界" in UTF-8; the split falls inside 你 (3 bytes) and 世 (3 bytes).
    const bytes = Buffer.from('{"text":"你世界"}\n', "utf8");
    const a = bytes.subarray(0, 5); // '{', '"', 't', 'e', 'x', 't' ... cutting 你
    const b = bytes.subarray(5, bytes.length - 2);
    const c = bytes.subarray(bytes.length - 2);
    expect(decode([a, b, c])).toEqual(['{"text":"你世界"}']);
  });

  it("splits on LF only, not on U+2028", () => {
    const record = JSON.stringify({ text: "a\u2028b\u2029c" });
    expect(decode([Buffer.from(`${record}\n`, "utf8")])).toEqual([record]);
  });

  it("strips CR from CRLF framing and skips empty lines", () => {
    expect(decode([Buffer.from('{"a":1}\r\n\r\n{"b":2}\r\n', "utf8")])).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("holds a partial line until its LF arrives", () => {
    expect(decode([Buffer.from('{"a":', "utf8"), Buffer.from("1}\n", "utf8")])).toEqual(['{"a":1}']);
  });
});

describe("checkOrigin", () => {
  it("allows a request without an origin (curl, tests)", () => {
    expect(checkOrigin(undefined)).toEqual({ allowed: true });
    expect(checkOrigin("")).toEqual({ allowed: true });
  });

  it("allows this machine's pages on any port", () => {
    // The dev setup serves the page from Vite (5173) and proxies to the bridge.
    expect(checkOrigin("http://127.0.0.1:5173")).toEqual({ allowed: true });
    expect(checkOrigin("http://localhost:5174")).toEqual({ allowed: true });
    expect(checkOrigin("http://[::1]:5173")).toEqual({ allowed: true });
  });

  it("rejects a page from the internet", () => {
    const decision = checkOrigin("https://evil.example");
    expect(decision.allowed).toBe(false);
  });

  it("rejects non-http origins such as sandboxed frames", () => {
    expect(checkOrigin("null").allowed).toBe(false);
    expect(checkOrigin("file:///tmp/x.html").allowed).toBe(false);
  });
});