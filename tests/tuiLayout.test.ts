import { describe, expect, it } from "vitest";
import { formatContextUsage } from "../src/tui/transcriptEvents.js";
import { computeComposerLayout, wrapDraftRows } from "../src/tui/layout.js";

describe("TUI layout helpers", () => {
  it.each([80, 120, 207])("keeps long prompts visible at %i columns", (width) => {
    const input = `${"please inspect the repository and then explain the most important architecture risks before writing a small patch ".repeat(14)}THE_VISIBLE_END`;
    const layout = computeComposerLayout({ input, width, promptWidth: "patch > ".length });

    expect(layout.height).toBeGreaterThanOrEqual(2);
    expect(layout.height).toBeLessThanOrEqual(6);
    expect(layout.visibleRows.length).toBe(layout.editorRows);
    expect(layout.visibleRows.at(-1)).toContain("THE_VISIBLE_END");
    expect(layout.hiddenRows).toBeGreaterThan(0);
  });

  it("uses the newest multiline draft rows when older rows overflow", () => {
    const input = ["first line", "second line", "third line", "fourth line", "fifth line", "sixth line", "seventh line"].join("\n");
    const layout = computeComposerLayout({ input, width: 80, promptWidth: "patch > ".length });

    expect(layout.height).toBe(6);
    expect(layout.visibleRows[0]).toBe("third line");
    expect(layout.visibleRows.at(-1)).toBe("seventh line");
  });

  it("preserves empty lines while wrapping drafts", () => {
    expect(wrapDraftRows("alpha\n\nbeta", 20)).toEqual(["alpha", "", "beta"]);
  });
});

describe("context meter formatting", () => {
  it("shows raw counts alongside the percentage", () => {
    expect(formatContextUsage(20_480, 41_000, 0.5)).toBe("20k/41k · 50%");
  });

  it("keeps small numbers exact rather than rounding them to 0k", () => {
    expect(formatContextUsage(512, 8192, 0.0625)).toBe("512/8k · 6%");
  });

  it("abbreviates million-token windows", () => {
    expect(formatContextUsage(500_000, 1_000_000, 0.5)).toBe("500k/1.0M · 50%");
  });
});
