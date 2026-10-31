import { describe, expect, it } from "vitest";
import { compactDiff } from "../src/core/lineDiff.js";

describe("compactDiff", () => {
  it("shows a changed line with one line of context", () => {
    expect(compactDiff("a\nb\nc\nd", "a\nb\nX\nd")).toBe(" b\n-c\n+X\n d");
  });

  it("lists a new file as additions and caps it", () => {
    expect(compactDiff("", "one\ntwo")).toBe("+one\n+two");
    expect(compactDiff("", "1\n2\n3\n4", { maxLines: 2 })).toBe("+1\n+2\n@@ 2 more lines");
  });

  it("collapses a long unchanged stretch between two edits", () => {
    const before = ["a", "1", "2", "3", "4", "5", "z"].join("\n");
    const after = ["A", "1", "2", "3", "4", "5", "Z"].join("\n");
    expect(compactDiff(before, after).split("\n")).toEqual(["-a", "+A", " 1", "@@", " 5", "-z", "+Z"]);
  });

  it("stays bounded for huge rewrites", () => {
    const big = Array.from({ length: 2000 }, (_, index) => `line ${index}`).join("\n");
    const other = Array.from({ length: 2000 }, (_, index) => `other ${index}`).join("\n");
    expect(compactDiff(big, other).split("\n").length).toBeLessThanOrEqual(25);
  });
});
