import { describe, expect, it } from "vitest";
import { describeUltraModes, hasUltraMode, parseUltraModes } from "../src/tui/experimental/ultraModes.js";

describe("parseUltraModes", () => {
  it("detects a single keyword anywhere in the prompt, not just at the start", () => {
    const parsed = parseUltraModes("please refactor this ultramaxx and add tests");
    expect(parsed.modes).toEqual(["maxx"]);
    expect(parsed.cleaned).toBe("please refactor this and add tests");
    expect(parsed.conflict).toBeNull();
  });

  it("combines compatible modes", () => {
    const parsed = parseUltraModes("ultramaxx ultraloop finish the migration");
    expect(parsed.modes).toEqual(["maxx", "loop"]);
    expect(parsed.conflict).toBeNull();
  });

  it("rejects ultramaxx + ultracheap as a conflict", () => {
    const parsed = parseUltraModes("ultramaxx ultracheap do the thing");
    expect(parsed.modes).toEqual(["maxx", "cheap"]);
    expect(parsed.conflict).toContain("cannot be combined");
  });

  it("captures a focus path with a colon", () => {
    const parsed = parseUltraModes("ultrafocus:src/core/agent.ts fix the retry bug");
    expect(parsed.modes).toEqual(["focus"]);
    expect(parsed.focusPath).toBe("src/core/agent.ts");
    expect(parsed.cleaned).toBe("fix the retry bug");
  });

  it("captures a quoted focus path with spaces", () => {
    const parsed = parseUltraModes('ultrafocus "my docs/notes.md" summarize it');
    expect(parsed.focusPath).toBe("my docs/notes.md");
    expect(parsed.cleaned).toBe("summarize it");
  });

  it("orders modes stably regardless of where they appear", () => {
    const parsed = parseUltraModes("loop it ultraloop and ultramaxx too");
    expect(parsed.modes).toEqual(["maxx", "loop"]);
  });

  it("does not trigger on substrings or hyphenated words", () => {
    expect(hasUltraMode("explain what ultramaxx-style means")).toBe(false);
    expect(hasUltraMode("the ultramaxxer tool")).toBe(false);
    expect(parseUltraModes("a normal prompt with no modes").modes).toEqual([]);
  });

  it("strips every keyword from a multi-mode prompt", () => {
    const parsed = parseUltraModes("ultracheap ultrafocus:lib.ts ultraloop tidy up");
    expect(parsed.modes).toEqual(["cheap", "focus", "loop"]);
    expect(parsed.cleaned).toBe("tidy up");
    expect(parsed.conflict).toBeNull();
  });
});

describe("describeUltraModes", () => {
  it("joins keywords for transcript messages", () => {
    expect(describeUltraModes(["maxx", "loop"])).toBe("ultramaxx + ultraloop");
  });
});
