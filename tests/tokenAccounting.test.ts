import { describe, expect, it } from "vitest";
import { addTelemetryToSession, attachTokenCost, emptySessionTelemetry, estimateCloudEquivalentCost } from "../src/core/tokenAccounting.js";
import type { ModelTelemetry } from "../src/core/types.js";

describe("token accounting", () => {
  it("keeps known costs when a later request has unknown pricing", () => {
    const first = telemetry({ estimatedCostUsd: 0.01, costSource: "api-pricing" });
    const second = telemetry({ estimatedCostUsd: null, costSource: "unknown" });
    const session = addTelemetryToSession(addTelemetryToSession(emptySessionTelemetry(), first), second);

    expect(session.estimatedCostUsd).toBe(0.01);
    expect(session.costSource).toBe("mixed");
  });

  it("charges nothing for local inference", () => {
    for (const provider of ["ollama", "local-openai"] as const) {
      const result = attachTokenCost(usage(), provider, "qwen3:8b");
      expect(result.estimatedCostUsd).toBe(0);
      expect(result.costSource).toBe("local");
    }
  });

  it("clamps cached prompt tokens to the prompt total", () => {
    const result = attachTokenCost({ ...usage(), promptTokens: 100, cachedPromptTokens: 500 }, "ollama", "qwen3:8b");
    expect(result.cachedPromptTokens).toBe(100);
  });

  it("prices the cloud equivalent so the saved figure is non-zero", () => {
    expect(estimateCloudEquivalentCost(1_000_000, 1_000_000)).toBe(6);
    expect(estimateCloudEquivalentCost(0, 0)).toBe(0);
  });

  it("discounts cached prompt tokens in the cloud comparison", () => {
    const uncached = estimateCloudEquivalentCost(1_000_000, 0);
    const cached = estimateCloudEquivalentCost(1_000_000, 0, 1_000_000);
    expect(cached).toBeLessThan(uncached);
  });
});

function usage(): Omit<ModelTelemetry, "estimatedCostUsd" | "costSource"> {
  return {
    promptTokens: 1000,
    cachedPromptTokens: 0,
    cacheWriteTokens: 0,
    responseTokens: 100,
    totalTokens: 1100,
    evalTokensPerSecond: null,
    promptDurationMs: 0,
    responseDurationMs: 0,
    totalDurationMs: 0,
    tokenSource: "provider"
  };
}

function telemetry(overrides: Pick<ModelTelemetry, "estimatedCostUsd" | "costSource">): ModelTelemetry {
  return { ...usage(), ...overrides };
}
