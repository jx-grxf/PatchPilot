import type { ModelTelemetry, SessionTelemetry } from "./types.js";

type TokenCostRate = {
  inputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
};

/**
 * Local inference costs nothing to run, so there is no pricing table any more.
 * This rate exists only to answer "what would this session have cost on a
 * hosted API?" — a rough mid-tier reference, not a quote for any real product.
 */
const cloudReferenceRate: TokenCostRate = {
  inputPerMillion: 1,
  cachedInputPerMillion: 0.1,
  outputPerMillion: 5
};

export function estimateTokens(value: string): number {
  const normalizedValue = value.trim();
  return normalizedValue ? Math.ceil(normalizedValue.length / 4) : 0;
}

export function attachTokenCost(
  telemetry: Omit<ModelTelemetry, "estimatedCostUsd" | "costSource">,
  _provider: unknown,
  _model: string
): ModelTelemetry {
  return {
    ...telemetry,
    cachedPromptTokens: Math.min(telemetry.cachedPromptTokens, telemetry.promptTokens),
    estimatedCostUsd: 0,
    costSource: "local"
  };
}

/**
 * What the same token counts would have cost on a hosted API. Surfaced as the
 * amount running locally saved, so it is deliberately a single reference rate
 * rather than a per-vendor lookup.
 */
export function estimateCloudEquivalentCost(promptTokens: number, responseTokens: number, cachedPromptTokens = 0): number {
  const safeCachedTokens = Math.min(cachedPromptTokens, promptTokens);
  const uncachedTokens = Math.max(0, promptTokens - safeCachedTokens);
  return (
    (uncachedTokens * cloudReferenceRate.inputPerMillion +
      safeCachedTokens * cloudReferenceRate.cachedInputPerMillion +
      responseTokens * cloudReferenceRate.outputPerMillion) /
    1_000_000
  );
}

export function emptySessionTelemetry(): SessionTelemetry {
  return {
    requests: 0,
    promptTokens: 0,
    cachedPromptTokens: 0,
    cacheWriteTokens: 0,
    responseTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: null,
    costSource: "unknown"
  };
}

export function addTelemetryToSession(session: SessionTelemetry, telemetry: ModelTelemetry): SessionTelemetry {
  const estimatedCostUsd =
    session.requests === 0
      ? telemetry.estimatedCostUsd
      : session.estimatedCostUsd === null
        ? telemetry.estimatedCostUsd
        : telemetry.estimatedCostUsd === null
          ? session.estimatedCostUsd
          : session.estimatedCostUsd + telemetry.estimatedCostUsd;

  return {
    requests: session.requests + 1,
    promptTokens: session.promptTokens + telemetry.promptTokens,
    cachedPromptTokens: session.cachedPromptTokens + telemetry.cachedPromptTokens,
    cacheWriteTokens: session.cacheWriteTokens + telemetry.cacheWriteTokens,
    responseTokens: session.responseTokens + telemetry.responseTokens,
    totalTokens: session.totalTokens + telemetry.totalTokens,
    estimatedCostUsd,
    costSource: mergeCostSource(session.costSource, telemetry.costSource, session.requests)
  };
}

function mergeCostSource(
  currentSource: SessionTelemetry["costSource"],
  nextSource: ModelTelemetry["costSource"],
  previousRequests: number
): SessionTelemetry["costSource"] {
  if (previousRequests === 0) {
    return nextSource;
  }

  return currentSource === nextSource ? currentSource : "mixed";
}
