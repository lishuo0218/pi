import { describe, expect, it } from "vitest";
import { thinkingLabel } from "../src/model-picker.tsx";

describe("thinkingLabel", () => {
  it("names the levels pi offers", () => {
    expect(["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(thinkingLabel)).toEqual([
      "关",
      "最少",
      "低",
      "中",
      "高",
      "很高",
      "最高",
    ]);
  });

  it("shows a level it does not know as is", () => {
    expect(thinkingLabel("turbo")).toBe("turbo");
  });
});