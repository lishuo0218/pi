import { describe, expect, it } from "vitest";
import { codeSpan, pathDragPath } from "../src/path-drag.ts";

describe("pathDragPath", () => {
  it("joins a windows working directory with backslashes", () => {
    expect(pathDragPath("D:\\download\\pi\\webui", "src/app.tsx")).toBe("D:\\download\\pi\\webui\\src\\app.tsx");
  });

  it("keeps posix separators", () => {
    expect(pathDragPath("/home/u/project", "a/b.txt")).toBe("/home/u/project/a/b.txt");
  });

  it("drops a trailing separator from the working directory", () => {
    expect(pathDragPath("/home/u/project/", "a.txt")).toBe("/home/u/project/a.txt");
  });

  it("refers to the directory itself for the root row", () => {
    expect(pathDragPath("D:\\download\\pi\\webui", "")).toBe("D:\\download\\pi\\webui");
  });
});

describe("codeSpan", () => {
  it("reads a path as one-line code in a message", () => {
    expect(codeSpan("D:\\download\\pi\\webui\\src\\app.tsx")).toBe("`D:\\download\\pi\\webui\\src\\app.tsx`");
  });
});