import { describe, expect, it } from "vitest";
import { hasUltramaxx, splitUltramaxxSegments, stripUltramaxx } from "../src/tui/experimental/ultramaxx.js";
import { todoDockHeightFor } from "../src/tui/experimental/layout.js";

describe("ultramaxx keyword detection", () => {
  it("detects the keyword case-insensitively as a whole word", () => {
    expect(hasUltramaxx("ultramaxx refactor the loop")).toBe(true);
    expect(hasUltramaxx("please ULTRAMAXX this")).toBe(true);
    expect(hasUltramaxx("ultramaxxed is not the keyword")).toBe(false);
    expect(hasUltramaxx("just a normal task")).toBe(false);
  });

  it("strips the keyword and collapses leftover whitespace", () => {
    expect(stripUltramaxx("ultramaxx refactor the agent loop")).toBe("refactor the agent loop");
    expect(stripUltramaxx("refactor ultramaxx the loop")).toBe("refactor the loop");
    expect(stripUltramaxx("ultramaxx")).toBe("");
  });

  it("splits a line into plain and ultramaxx segments for rendering", () => {
    const segments = splitUltramaxxSegments("go ultramaxx now");
    expect(segments).toEqual([
      { text: "go ", ultramaxx: false },
      { text: "ultramaxx", ultramaxx: true },
      { text: " now", ultramaxx: false },
    ]);
    expect(splitUltramaxxSegments("plain text")).toEqual([{ text: "plain text", ultramaxx: false }]);
  });
});

describe("todoDockHeightFor", () => {
  it("is hidden with no todos and capped for many todos", () => {
    expect(todoDockHeightFor(0)).toBe(0);
    expect(todoDockHeightFor(3)).toBe(3 + 1 + 2);
    expect(todoDockHeightFor(20)).toBe(6 + 1 + 2);
  });
});
