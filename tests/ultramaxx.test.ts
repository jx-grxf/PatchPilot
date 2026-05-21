import { describe, expect, it } from "vitest";
import { hasUltramaxx, splitUltramaxxSegments, stripUltramaxx } from "../src/tui/experimental/ultramaxx.js";
import { todoDockHeightFor } from "../src/tui/experimental/layout.js";

describe("ultramaxx keyword detection", () => {
  it("detects only explicit activators at the start of the prompt", () => {
    expect(hasUltramaxx("ultramaxx refactor the loop")).toBe(true);
    expect(hasUltramaxx("ULTRAMAXX: refactor the loop")).toBe(true);
    expect(hasUltramaxx("/ultramaxx refactor the loop")).toBe(true);
    expect(hasUltramaxx("please ULTRAMAXX this")).toBe(false);
    expect(hasUltramaxx("ultramaxxed is not the keyword")).toBe(false);
    expect(hasUltramaxx("just a normal task")).toBe(false);
  });

  it("strips only the activator and collapses leftover whitespace", () => {
    expect(stripUltramaxx("ultramaxx refactor the agent loop")).toBe("refactor the agent loop");
    expect(stripUltramaxx("ULTRAMAXX: refactor the agent loop")).toBe("refactor the agent loop");
    expect(stripUltramaxx("/ultramaxx refactor the agent loop")).toBe("refactor the agent loop");
    expect(stripUltramaxx("refactor ultramaxx the loop")).toBe("refactor ultramaxx the loop");
    expect(stripUltramaxx("ultramaxx")).toBe("");
  });

  it("splits explicit activators into plain and ultramaxx segments for rendering", () => {
    const segments = splitUltramaxxSegments("/ultramaxx now");
    expect(segments).toEqual([
      { text: "/", ultramaxx: false },
      { text: "ultramaxx", ultramaxx: true },
      { text: " now", ultramaxx: false },
    ]);
    expect(splitUltramaxxSegments("go ultramaxx now")).toEqual([{ text: "go ultramaxx now", ultramaxx: false }]);
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
