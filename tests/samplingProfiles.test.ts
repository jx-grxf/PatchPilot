import { describe, expect, it } from "vitest";
import { samplingFor } from "../src/core/samplingProfiles.js";

describe("samplingFor", () => {
  it("uses the family's published values", () => {
    expect(samplingFor("mlx-community/Qwen3.6-35B-A3B-4bit", {})).toEqual({ temperature: 0.7, topP: 0.8, topK: 20 });
    expect(samplingFor("gpt-oss:20b", {}).temperature).toBe(1);
    expect(samplingFor("devstral:24b", {}).temperature).toBe(0.15);
  });

  it("lets explicit settings win", () => {
    expect(samplingFor("qwen3:8b", { PATCHPILOT_TEMPERATURE: "0.2", PATCHPILOT_TOP_K: "0" })).toEqual({ temperature: 0.2, topP: 0.8, topK: 0 });
  });

  it("has a conservative fallback for unknown models", () => {
    expect(samplingFor("some-model", {}).temperature).toBeLessThanOrEqual(0.3);
  });
});
