import { describe, expect, it } from "vitest";
import {
  formatElapsed,
  formatRunStatus,
  runStatusVerb,
  runStatusVerbs,
  spinnerFrameMs,
  spinnerGlyph,
  spinnerGlyphs,
  verbCycleMs,
} from "../src/tui/runStatus.js";

describe("run-status verb stability", () => {
  it("keeps the same verb for the whole 10s window", () => {
    const verb = runStatusVerb(0);
    expect(runStatusVerb(1)).toBe(verb);
    expect(runStatusVerb(4999)).toBe(verb);
    expect(runStatusVerb(verbCycleMs - 1)).toBe(verb);
  });

  it("advances the verb only when the slow cycle elapses", () => {
    expect(runStatusVerb(verbCycleMs)).not.toBe(runStatusVerb(0));
    expect(runStatusVerb(verbCycleMs * 2)).not.toBe(runStatusVerb(verbCycleMs));
  });

  it("does not change the verb across consecutive fast spinner frames", () => {
    // The verb must never be derived from the spinner frame.
    const elapsed = 3200;
    const first = formatRunStatus({ workState: "reading", status: "", elapsedMs: elapsed });
    const second = formatRunStatus({ workState: "reading", status: "", elapsedMs: elapsed + spinnerFrameMs });
    expect(first).toBe(second);
  });

  it("is deterministic and bounded", () => {
    expect(runStatusVerb(-100)).toBe(runStatusVerbs[0]);
    expect(runStatusVerbs).toContain(runStatusVerb(999_999));
  });
});

describe("spinner glyphs", () => {
  it("cycles the braille frames", () => {
    expect(spinnerGlyph(0)).toBe(spinnerGlyphs[0]);
    expect(spinnerGlyph(spinnerGlyphs.length)).toBe(spinnerGlyphs[0]);
    expect(spinnerGlyph(1)).not.toBe(spinnerGlyph(0));
  });

  it("handles negative and fractional frames", () => {
    expect(spinnerGlyphs).toContain(spinnerGlyph(-3));
    expect(spinnerGlyphs).toContain(spinnerGlyph(2.7));
  });
});

describe("formatRunStatus", () => {
  it("includes the work state and an optional status detail", () => {
    expect(formatRunStatus({ workState: "waiting_approval", status: "", elapsedMs: 0 })).toContain("waiting approval");
    expect(formatRunStatus({ workState: "reading", status: "scanning src", elapsedMs: 0 })).toContain(": scanning src");
  });

  it("drops the detail when it merely repeats the state", () => {
    expect(formatRunStatus({ workState: "reading", status: "reading", elapsedMs: 0 })).not.toContain(":");
  });
});

describe("formatElapsed", () => {
  it("formats seconds and minutes", () => {
    expect(formatElapsed(0)).toBe("starting");
    expect(formatElapsed(4200)).toBe("4s");
    expect(formatElapsed(75_000)).toBe("1m 15s");
  });
});
