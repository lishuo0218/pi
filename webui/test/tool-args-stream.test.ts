// Arguments of a streaming tool call, read from the argument JSON received so
// far: the card names its target file from the first delta and the write card
// shows the content while the model is still emitting it. pi sends delta-only
// `message_update` records (json.md "Reconstruct streaming messages"), so the
// values have to come from the text itself.
import { describe, expect, it } from "vitest";
import { readStreamedArgs } from "../src/tool-args-stream.ts";

describe("readStreamedArgs", () => {
  it("reads the target out of a complete argument object", () => {
    expect(readStreamedArgs('{"path":"a.ts","edits":[{"oldText":"x","newText":"y"}]}')).toEqual({
      path: { key: "path", value: "a.ts", complete: true },
      content: null,
    });
  });

  it("decodes an escaped Windows path while it is still streaming", () => {
    expect(readStreamedArgs('{"path":"D:\\\\downl').path).toEqual({
      key: "path",
      value: "D:\\downl",
      complete: false,
    });
  });

  it("accepts the argument names of the older tools", () => {
    expect(readStreamedArgs('{"file_path":"src/a.ts"').path).toEqual({
      key: "file_path",
      value: "src/a.ts",
      complete: true,
    });
  });

  it("returns nothing before a path key has arrived", () => {
    expect(readStreamedArgs('{"edits":[{"oldTe')).toEqual({ path: null, content: null });
  });

  it("decodes the written content while it streams", () => {
    expect(readStreamedArgs('{"path":"src/a.ts","content":"export const a = 1;\\n')).toEqual({
      path: { key: "path", value: "src/a.ts", complete: true },
      content: "export const a = 1;\n",
    });
  });

  it("finds the path when the model emits the content first", () => {
    const raw = JSON.stringify({ content: "let a = 1;\n", path: "src/a.ts" });
    expect(readStreamedArgs(raw)).toEqual({
      path: { key: "path", value: "src/a.ts", complete: true },
      content: "let a = 1;\n",
    });
  });

  it("does not read key names written into the file as arguments", () => {
    const content = '{"path": "wrong.ts"}';
    expect(readStreamedArgs(JSON.stringify({ content, path: "src/a.ts" }))).toEqual({
      path: { key: "path", value: "src/a.ts", complete: true },
      content,
    });
  });

  it("holds back an escape that a delta boundary cut in half", () => {
    // "\u00e4" split after "00": the card never shows the raw escape text.
    expect(readStreamedArgs('{"content":"Gr\\u00').content).toBe("Gr");
    expect(readStreamedArgs('{"content":"Gr\\u00e4').content).toBe("Grä");
    expect(readStreamedArgs('{"content":"a\\').content).toBe("a");
    expect(readStreamedArgs('{"content":"a\\n').content).toBe("a\n");
  });

  it("keeps reading arguments that follow the content", () => {
    const raw = '{"content":"x","overwrite":true,"path":"a.ts"}';
    expect(readStreamedArgs(raw).path).toEqual({ key: "path", value: "a.ts", complete: true });
  });
});