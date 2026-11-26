import { describe, expect, it } from "vitest";
import { rememberSentChips, userParts } from "../src/user-chips.ts";

describe("userParts", () => {
  it("turns an absolute path span into a chip", () => {
    expect(userParts("看看 `D:\\download\\pi\\webui\\src\\app.tsx`")).toEqual([
      { kind: "text", text: "看看 " },
      { kind: "chip", path: "D:\\download\\pi\\webui\\src\\app.tsx" },
    ]);
  });

  it("takes posix absolute paths too", () => {
    expect(userParts("`/home/u/app.tsx` 改一下")).toEqual([
      { kind: "chip", path: "/home/u/app.tsx" },
      { kind: "text", text: " 改一下" },
    ]);
  });

  it("keeps relative paths in the text", () => {
    const text = "改 `src/app.tsx` 的样式";
    expect(userParts(text)).toEqual([{ kind: "text", text }]);
  });

  it("keeps prose in code spans as text", () => {
    const text = "运行 `npm run check`";
    expect(userParts(text)).toEqual([{ kind: "text", text }]);
  });

  it("splits several chips with the text between them", () => {
    expect(userParts("`/a.ts` 和 `/b.ts`")).toEqual([
      { kind: "chip", path: "/a.ts" },
      { kind: "text", text: " 和 " },
      { kind: "chip", path: "/b.ts" },
    ]);
  });

  it("leaves multiline code spans alone", () => {
    const text = "```\n/tmp/a\n```";
    expect(userParts(text)).toEqual([{ kind: "text", text }]);
  });
});

describe("rememberSentChips", () => {
  it("marks only the chips a prompt really carried", () => {
    const text = "`/tmp/typed.ts` 和 `/tmp/dropped.ts`";
    rememberSentChips(text, ["/tmp/dropped.ts"]);
    expect(userParts(text)).toEqual([
      { kind: "text", text: "`/tmp/typed.ts` 和 " },
      { kind: "chip", path: "/tmp/dropped.ts" },
    ]);
  });

  it("falls back to the heuristic for prompts without chips", () => {
    const text = "`/tmp/older.ts`";
    rememberSentChips(text, []);
    expect(userParts(text)).toEqual([{ kind: "chip", path: "/tmp/older.ts" }]);
  });
});