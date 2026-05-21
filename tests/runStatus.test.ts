import { describe, expect, it } from "vitest";
import {
  completionVerbs,
  formatCompletionSummary,
  formatElapsed,
  formatRunDuration,
  pulseGlyph,
  pulseGlyphs,
  randomRunStatusSeed,
  runStatusParts,
  runStatusVerb,
  runStatusVerbs,
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

  it("does not change the verb across consecutive fast spinner frames", () => {
    // The verb must never be derived from the spinner frame.
    const elapsed = 3200;
    const first = runStatusParts({ workState: "reading", status: "", elapsedMs: elapsed }).verb;
    const second = runStatusParts({ workState: "reading", status: "", elapsedMs: elapsed + 90 }).verb;
    expect(first).toBe(second);
  });

  it("rotates through several verbs and is not a fixed alphabetical cycle", () => {
    const seen = new Set<string>();
    let sequentialSteps = 0;
    for (let tick = 0; tick < 30; tick += 1) {
      const verb = runStatusVerb(tick * verbCycleMs);
      const next = runStatusVerb((tick + 1) * verbCycleMs);
      seen.add(verb);
      if (runStatusVerbs.indexOf(next) === runStatusVerbs.indexOf(verb) + 1) {
        sequentialSteps += 1;
      }
    }
    expect(seen.size).toBeGreaterThan(5);
    // A pseudo-random order should almost never advance strictly by +1.
    expect(sequentialSteps).toBeLessThan(5);
  });

  it("does not repeat the same verb at a cycle boundary for one run seed", () => {
    const seed = randomRunStatusSeed(() => 0.42);
    for (let tick = 1; tick < 20; tick += 1) {
      expect(runStatusVerb(tick * verbCycleMs, seed)).not.toBe(runStatusVerb((tick - 1) * verbCycleMs, seed));
    }
  });

  it("is deterministic and always returns a known verb", () => {
    expect(runStatusVerb(12_345)).toBe(runStatusVerb(12_345));
    expect(runStatusVerbs).toContain(runStatusVerb(-100));
    expect(runStatusVerbs).toContain(runStatusVerb(999_999));
  });

  it("can create deterministic random seeds from an injected random source", () => {
    expect(randomRunStatusSeed(() => 0)).toBe(0);
    expect(randomRunStatusSeed(() => 0.5)).toBeGreaterThan(0);
    expect(randomRunStatusSeed(() => 1)).toBeLessThanOrEqual(0x7fffffff);
  });
});

describe("spinner and pulse glyphs", () => {
  it("cycles the braille frames", () => {
    expect(spinnerGlyph(0)).toBe(spinnerGlyphs[0]);
    expect(spinnerGlyph(spinnerGlyphs.length)).toBe(spinnerGlyphs[0]);
    expect(spinnerGlyph(1)).not.toBe(spinnerGlyph(0));
  });

  it("cycles the pulse glyphs and tolerates odd frames", () => {
    expect(pulseGlyph(0)).toBe(pulseGlyphs[0]);
    expect(pulseGlyphs).toContain(pulseGlyph(-3));
    expect(pulseGlyphs).toContain(pulseGlyph(2.7));
  });
});

describe("runStatusParts", () => {
  it("splits the status into verb, state, and detail", () => {
    const parts = runStatusParts({ workState: "waiting_approval", status: "scanning src", elapsedMs: 0 });
    expect(runStatusVerbs).toContain(parts.verb);
    expect(parts.state).toBe("waiting approval");
    expect(parts.detail).toBe("scanning src");
  });

  it("drops the detail when it merely repeats the state", () => {
    expect(runStatusParts({ workState: "reading", status: "reading", elapsedMs: 0 }).detail).toBe("");
  });
});

describe("duration formatting", () => {
  it("formats seconds, minutes, and hours", () => {
    expect(formatElapsed(0)).toBe("starting");
    expect(formatElapsed(4200)).toBe("4s");
    expect(formatRunDuration(75_000)).toBe("1m 15s");
    expect(formatRunDuration(3_900_000)).toBe("1h 05m");
  });

  it("builds a completion summary like 'Crunched for 17m 58s'", () => {
    const summary = formatCompletionSummary(1_078_000, 3);
    expect(summary).toMatch(/^[A-Z][a-z]+ for \d+m \d{2}s$/);
    expect(completionVerbs).toContain(summary.split(" ")[0]);
  });
});
