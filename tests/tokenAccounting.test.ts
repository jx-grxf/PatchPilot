import { describe, expect, it } from "vitest";
import { addTelemetryToSession, attachTokenCost, emptySessionTelemetry, estimateComparableApiCost } from "../src/core/tokenAccounting.js";
import type { ModelTelemetry } from "../src/core/types.js";

describe("token accounting", () => {
  it("keeps known costs when a later request has unknown pricing", () => {
    const first = telemetry({ estimatedCostUsd: 0.01, costSource: "api-pricing" });
    const second = telemetry({ estimatedCostUsd: null, costSource: "unknown" });
    const session = addTelemetryToSession(addTelemetryToSession(emptySessionTelemetry(), first), second);

    expect(session.estimatedCostUsd).toBe(0.01);
    expect(session.costSource).toBe("mixed");
  });

  it("uses Gemini API pricing for Gemini and the Gemini-Wrapper comparable saved value", () => {
    const gemini = attachTokenCost(
      {
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
      },
      "gemini",
      "gemini-2.5-flash"
    );

    expect(gemini.costSource).toBe("api-pricing");
    expect(gemini.estimatedCostUsd).toBeGreaterThan(0);
    expect(estimateComparableApiCost("gemini-wrapper", "gemini-2.5-flash", 1000, 100).source).toBe("api-pricing");
  });
});

function telemetry(overrides: Pick<ModelTelemetry, "estimatedCostUsd" | "costSource">): ModelTelemetry {
  return {
    promptTokens: 10,
    cachedPromptTokens: 0,
    cacheWriteTokens: 0,
    responseTokens: 5,
    totalTokens: 15,
    evalTokensPerSecond: null,
    promptDurationMs: 0,
    responseDurationMs: 0,
    totalDurationMs: 0,
    tokenSource: "provider",
    ...overrides
  };
}
