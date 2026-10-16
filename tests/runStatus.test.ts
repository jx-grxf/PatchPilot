import { describe, expect, it } from "vitest";
import {
  describeRunActivity,
  formatCompletionSummary,
  formatElapsed,
  formatRunDuration,
  spinnerGlyph,
  spinnerGlyphs
} from "../src/tui/runStatus.js";

describe("spinner", () => {
  it("cycles the braille frames and tolerates odd frames", () => {
    expect(spinnerGlyph(0)).toBe(spinnerGlyphs[0]);
    expect(spinnerGlyph(spinnerGlyphs.length)).toBe(spinnerGlyphs[0]);
    expect(spinnerGlyph(1)).not.toBe(spinnerGlyph(0));
    expect(spinnerGlyphs).toContain(spinnerGlyph(-3));
    expect(spinnerGlyphs).toContain(spinnerGlyph(2.7));
  });
});

describe("describeRunActivity", () => {
  it("names the work state when no model call is streaming", () => {
    expect(describeRunActivity("waiting_approval", null).label).toBe("Waiting for approval");
    expect(describeRunActivity("verifying", null).label).toBe("Running commands");
  });

  it("separates prompt evaluation from generation", () => {
    expect(describeRunActivity("planning", { phase: "prompt", elapsedMs: 3000, tokens: 0, tokensPerSecond: null }).label).toBe("Reading prompt");
    expect(describeRunActivity("planning", { phase: "generating", elapsedMs: 3000, tokens: 1400, tokensPerSecond: 12 })).toEqual({
      label: "Generating",
      detail: "1.4k tok"
    });
  });

  it("explains the silence while a server buffers tool-call arguments", () => {
    const waiting = describeRunActivity("editing", {
      phase: "generating",
      elapsedMs: 90_000,
      tokens: 0,
      tokensPerSecond: null,
      writing: { tool: "write", chars: 0 }
    });
    expect(waiting.label).toBe("Writing a file");
    expect(waiting.detail).toContain("when the call is complete");

    const streaming = describeRunActivity("editing", {
      phase: "generating",
      elapsedMs: 90_000,
      tokens: 0,
      tokensPerSecond: null,
      writing: { tool: "write", chars: 12_400 }
    });
    expect(streaming.detail).toBe("12k chars");
  });
});

describe("duration formatting", () => {
  it("formats seconds, minutes, and hours", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(4200)).toBe("4s");
    expect(formatRunDuration(75_000)).toBe("1m 15s");
    expect(formatRunDuration(3_900_000)).toBe("1h 05m");
  });

  it("says how a run ended", () => {
    expect(formatCompletionSummary(1_078_000, "done")).toBe("Done in 17m 58s");
    expect(formatCompletionSummary(177_000, "failed")).toBe("Failed after 2m 57s");
    expect(formatCompletionSummary(4000, "stopped")).toBe("Stopped after 4s");
  });
});

describe("reasoning", () => {
  it("reads as thinking until visible tokens arrive", () => {
    expect(describeRunActivity("planning", { phase: "generating", elapsedMs: 2000, tokens: 0, tokensPerSecond: 0 }).label).toBe("Thinking");
  });
});
