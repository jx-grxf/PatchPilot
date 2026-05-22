import type { ModelProvider, ModelTelemetry, SessionTelemetry } from "./types.js";
import type { OpenRouterTokenRates } from "./openrouter.js";

type TokenCostRate = {
  inputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
};

const codexApiTokenRates: Record<string, TokenCostRate> = {
  "gpt-5.4": {
    inputPerMillion: 2.5,
    cachedInputPerMillion: 0.25,
    outputPerMillion: 15
  },
  "gpt-5.4-mini": {
    inputPerMillion: 0.75,
    cachedInputPerMillion: 0.075,
    outputPerMillion: 4.5
  },
  "gpt-5.2": {
    inputPerMillion: 1.75,
    cachedInputPerMillion: 0.175,
    outputPerMillion: 14
  },
  "gpt-5.2-codex": {
    inputPerMillion: 1.75,
    cachedInputPerMillion: 0.175,
    outputPerMillion: 14
  },
  "gpt-5.3-codex": {
    inputPerMillion: 1.75,
    cachedInputPerMillion: 0.175,
    outputPerMillion: 14
  },
  "gpt-5.1-codex-max": {
    inputPerMillion: 1.25,
    cachedInputPerMillion: 0.125,
    outputPerMillion: 10
  },
  "gpt-5.1-codex-mini": {
    inputPerMillion: 0.25,
    cachedInputPerMillion: 0.025,
    outputPerMillion: 2
  },
  "codex-mini-latest": {
    inputPerMillion: 1.5,
    cachedInputPerMillion: 0.375,
    outputPerMillion: 6
  }
};

const fallbackCloudRates: TokenCostRate = {
  inputPerMillion: 0.5,
  cachedInputPerMillion: 0.05,
  outputPerMillion: 2
};

const geminiApiTokenRates: Array<{ pattern: RegExp; rate: TokenCostRate }> = [
  { pattern: /(gemini-?3|3\.\d).*pro|gemini-?3-pro/i, rate: { inputPerMillion: 2, cachedInputPerMillion: 0.2, outputPerMillion: 12 } },
  { pattern: /2[._-]?5.*pro|gemini-pro|^pro$/i, rate: { inputPerMillion: 1.25, cachedInputPerMillion: 0.125, outputPerMillion: 10 } },
  { pattern: /flash[-_ ]?lite/i, rate: { inputPerMillion: 0.1, cachedInputPerMillion: 0.025, outputPerMillion: 0.4 } },
  { pattern: /flash/i, rate: { inputPerMillion: 0.3, cachedInputPerMillion: 0.075, outputPerMillion: 2.5 } }
];

export function estimateTokens(value: string): number {
  const normalizedValue = value.trim();
  return normalizedValue ? Math.ceil(normalizedValue.length / 4) : 0;
}

export function attachTokenCost(
  telemetry: Omit<ModelTelemetry, "estimatedCostUsd" | "costSource">,
  provider: ModelProvider,
  model: string,
  openRouterRates?: OpenRouterTokenRates | null,
  providerCostUsd?: number | null
): ModelTelemetry {
  if (provider === "ollama") {
    return {
      ...telemetry,
      estimatedCostUsd: 0,
      costSource: "local"
    };
  }

  if (provider === "openrouter") {
    if (providerCostUsd !== undefined && providerCostUsd !== null) {
      return {
        ...telemetry,
        cachedPromptTokens: Math.min(telemetry.cachedPromptTokens, telemetry.promptTokens),
        estimatedCostUsd: providerCostUsd,
        costSource: "api-pricing"
      };
    }

    if (!openRouterRates) {
      return {
        ...telemetry,
        cachedPromptTokens: Math.min(telemetry.cachedPromptTokens, telemetry.promptTokens),
        estimatedCostUsd: null,
        costSource: "unknown"
      };
    }

    const cachedPromptTokens = Math.min(telemetry.cachedPromptTokens, telemetry.promptTokens);
    const cacheWriteTokens = Math.min(telemetry.cacheWriteTokens, Math.max(0, telemetry.promptTokens - cachedPromptTokens));
    const uncachedPromptTokens = Math.max(0, telemetry.promptTokens - cachedPromptTokens - cacheWriteTokens);
    const estimatedCostUsd =
      uncachedPromptTokens * openRouterRates.inputPerToken +
      cachedPromptTokens * openRouterRates.cachedInputPerToken +
      cacheWriteTokens * openRouterRates.cacheWritePerToken +
      telemetry.responseTokens * openRouterRates.outputPerToken;

    return {
      ...telemetry,
      cachedPromptTokens,
      estimatedCostUsd,
      costSource: "api-pricing"
    };
  }

  if (provider === "gemini-wrapper") {
    return {
      ...telemetry,
      cachedPromptTokens: Math.min(telemetry.cachedPromptTokens, telemetry.promptTokens),
      estimatedCostUsd: 0,
      costSource: "free-route"
    };
  }

  const rates = provider === "codex" ? codexApiTokenRates[model] : provider === "gemini" ? readGeminiRates(model) : undefined;
  const effectiveRates = rates ?? fallbackCloudRates;
  const cachedPromptTokens = Math.min(telemetry.cachedPromptTokens, telemetry.promptTokens);
  const uncachedPromptTokens = Math.max(0, telemetry.promptTokens - cachedPromptTokens);
  const estimatedCostUsd =
    (uncachedPromptTokens * effectiveRates.inputPerMillion +
      cachedPromptTokens * effectiveRates.cachedInputPerMillion +
      telemetry.responseTokens * effectiveRates.outputPerMillion) /
    1_000_000;

  return {
    ...telemetry,
    cachedPromptTokens,
    estimatedCostUsd,
    costSource: rates ? "api-pricing" : "fallback-pricing"
  };
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

export function estimateComparableApiCost(provider: ModelProvider, model: string, promptTokens: number, responseTokens: number, cachedPromptTokens = 0): {
  costUsd: number | null;
  source: "api-pricing" | "fallback-pricing" | "unknown";
} {
  if (provider === "gemini-wrapper" || provider === "gemini") {
    const rates = readGeminiRates(model);
    if (!rates) {
      return {
        costUsd: estimateCost(promptTokens, responseTokens, cachedPromptTokens, fallbackCloudRates),
        source: "fallback-pricing"
      };
    }

    return {
      costUsd: estimateCost(promptTokens, responseTokens, cachedPromptTokens, rates),
      source: "api-pricing"
    };
  }

  if (provider === "ollama") {
    return {
      costUsd: estimateCost(promptTokens, responseTokens, cachedPromptTokens, fallbackCloudRates),
      source: "fallback-pricing"
    };
  }

  if (provider === "codex" || provider === "openrouter" || provider === "nvidia") {
    return {
      costUsd: 0,
      source: "api-pricing"
    };
  }

  return {
    costUsd: null,
    source: "unknown"
  };
}

function readGeminiRates(model: string): TokenCostRate | undefined {
  return geminiApiTokenRates.find((entry) => entry.pattern.test(model))?.rate;
}

function estimateCost(promptTokens: number, responseTokens: number, cachedPromptTokens: number, rates: TokenCostRate): number {
  const safeCachedTokens = Math.min(cachedPromptTokens, promptTokens);
  const uncachedTokens = Math.max(0, promptTokens - safeCachedTokens);
  return (uncachedTokens * rates.inputPerMillion + safeCachedTokens * rates.cachedInputPerMillion + responseTokens * rates.outputPerMillion) / 1_000_000;
}

function mergeCostSource(currentSource: SessionTelemetry["costSource"], nextSource: ModelTelemetry["costSource"], previousRequests: number): SessionTelemetry["costSource"] {
  if (previousRequests === 0) {
    return nextSource;
  }

  return currentSource === nextSource ? currentSource : "mixed";
}
