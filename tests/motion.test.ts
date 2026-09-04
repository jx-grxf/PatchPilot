import { describe, expect, it } from "vitest";
import {
  easeInOut,
  formatCompact,
  formatElapsed,
  motionEnabled,
  pressureColor,
  pulseFrame,
  shimmerIndex,
  smoothBar,
  sparkline,
  spinnerFrame,
  trackedBar
} from "../src/tui/motion.js";

describe("the smooth bar", () => {
  it("is exactly the requested width at every ratio", () => {
    for (const ratio of [0, 0.01, 0.33, 0.5, 0.999, 1]) {
      expect([...smoothBar(ratio, 10)], `ratio ${ratio}`).toHaveLength(10);
    }
  });

  it("is empty at zero and solid at one", () => {
    expect(smoothBar(0, 4).trim()).toBe("");
    expect(smoothBar(1, 4)).toBe("████");
  });

  it("uses a partial block so the bar moves in eighths, not whole cells", () => {
    // Two ratios inside the same cell must still render differently.
    expect(smoothBar(0.26, 4)).not.toBe(smoothBar(0.3, 4));
  });

  it("clamps rather than overflowing on out-of-range input", () => {
    expect(smoothBar(-1, 5)).toBe("     ");
    expect(smoothBar(4, 5)).toBe("█████");
  });

  it("shows its track when one is asked for", () => {
    expect(trackedBar(0.5, 6)).toContain("░");
    expect(trackedBar(0.5, 6)).toContain("█");
    expect([...trackedBar(0.1, 8)]).toHaveLength(8);
  });
});

describe("the sparkline", () => {
  it("is the requested width even with fewer samples", () => {
    expect([...sparkline([1, 2], 8)]).toHaveLength(8);
    expect([...sparkline([], 8)]).toHaveLength(8);
  });

  it("scales to its own window, so a trend is visible at any magnitude", () => {
    // Same shape, different magnitude, identical rendering.
    expect(sparkline([1, 2, 3, 4], 4)).toBe(sparkline([100, 200, 300, 400], 4));
  });

  it("puts the peak at full height and keeps order", () => {
    // Scaled from zero, not from the window minimum: a value at a quarter of
    // the peak reads as a quarter, rather than being flattened to the floor.
    expect(sparkline([1, 4], 2).endsWith("█")).toBe(true);
    expect(sparkline([4, 1], 2).startsWith("█")).toBe(true);
    expect(sparkline([1, 4], 2)).toBe([...sparkline([4, 1], 2)].reverse().join(""));
  });

  it("draws a flat line when nothing changed", () => {
    expect(sparkline([5, 5, 5], 3)).toBe("███");
  });

  it("keeps only the most recent samples", () => {
    expect(sparkline([9, 9, 9, 1, 2], 2)).toBe(sparkline([1, 2], 2));
  });
});

describe("spinners", () => {
  it("cycle without ever returning empty", () => {
    for (let frame = 0; frame < 40; frame += 1) {
      expect(spinnerFrame(frame)).toHaveLength(1);
      expect(pulseFrame(frame)).toHaveLength(1);
    }
  });

  it("advance every frame, so the motion reads as continuous", () => {
    expect(spinnerFrame(0)).not.toBe(spinnerFrame(1));
  });

  it("pulses more slowly than the spinner, because waiting is not working", () => {
    expect(pulseFrame(0)).toBe(pulseFrame(1));
  });
});

describe("the shimmer", () => {
  it("sweeps across the word and then rests", () => {
    const positions = Array.from({ length: 12 }, (_, frame) => shimmerIndex(frame, 6));
    expect(positions.slice(0, 6)).toEqual([0, 1, 2, 3, 4, 5]);
    // The gap is what makes it a heartbeat rather than a glitch.
    expect(positions.slice(6)).toEqual([-1, -1, -1, -1, -1, -1]);
  });

  it("does nothing for an empty word", () => {
    expect(shimmerIndex(3, 0)).toBe(-1);
  });
});

describe("easing", () => {
  it("pins the ends and passes through the middle", () => {
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(1)).toBe(1);
    expect(easeInOut(0.5)).toBeCloseTo(0.5, 5);
  });

  it("starts slower than linear, so motion accelerates away from rest", () => {
    expect(easeInOut(0.25)).toBeLessThan(0.25);
    expect(easeInOut(0.75)).toBeGreaterThan(0.75);
  });

  it("clamps out-of-range input", () => {
    expect(easeInOut(-1)).toBe(0);
    expect(easeInOut(2)).toBe(1);
  });
});

describe("meter colour", () => {
  it("warns before it is too late rather than at the wall", () => {
    expect(pressureColor(0.4)).toBe("green");
    expect(pressureColor(0.75)).toBe("cyan");
    expect(pressureColor(0.9)).toBe("yellow");
    expect(pressureColor(1)).toBe("red");
  });
});

describe("number formatting", () => {
  it("shows sub-second precision only where it matters", () => {
    expect(formatElapsed(1500)).toBe("1.5s");
    expect(formatElapsed(42_000)).toBe("42s");
    expect(formatElapsed(125_000)).toBe("2m05s");
  });

  it("compacts large counts and leaves small ones exact", () => {
    expect(formatCompact(742)).toBe("742");
    expect(formatCompact(9100)).toBe("9.1k");
    expect(formatCompact(42_000)).toBe("42k");
    expect(formatCompact(1_500_000)).toBe("1.5M");
  });
});

describe("when motion should run at all", () => {
  it("stays still when output is piped, where frames become noise", () => {
    expect(motionEnabled({}, false)).toBe(false);
    expect(motionEnabled({}, true)).toBe(true);
  });

  it("honours an explicit request to reduce motion", () => {
    expect(motionEnabled({ PATCHPILOT_REDUCE_MOTION: "1" }, true)).toBe(false);
    expect(motionEnabled({ PATCHPILOT_REDUCE_MOTION: "0" }, true)).toBe(true);
  });
});
