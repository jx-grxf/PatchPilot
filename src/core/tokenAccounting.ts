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

  const rates = provider === "codex" ? codexApiTokenRates[model] : undefined;
  if (!rates) {
    return {
      ...telemetry,
      estimatedCostUsd: null,
      costSource: "unknown"
    };
  }

  const cachedPromptTokens = Math.min(telemetry.cachedPromptTokens, telemetry.promptTokens);
  const uncachedPromptTokens = Math.max(0, telemetry.promptTokens - cachedPromptTokens);
  const estimatedCostUsd =
    (uncachedPromptTokens * rates.inputPerMillion +
      cachedPromptTokens * rates.cachedInputPerMillion +
      telemetry.responseTokens * rates.outputPerMillion) /
    1_000_000;

  return {
    ...telemetry,
    cachedPromptTokens,
    estimatedCostUsd,
    costSource: "api-pricing"
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
    estimatedCostUsd: null
  };
}

export function addTelemetryToSession(session: SessionTelemetry, telemetry: ModelTelemetry): SessionTelemetry {
  const estimatedCostUsd =
    session.requests === 0
      ? telemetry.estimatedCostUsd
      : session.estimatedCostUsd === null || telemetry.estimatedCostUsd === null
      ? null
      : session.estimatedCostUsd + telemetry.estimatedCostUsd;

  return {
    requests: session.requests + 1,
    promptTokens: session.promptTokens + telemetry.promptTokens,
    cachedPromptTokens: session.cachedPromptTokens + telemetry.cachedPromptTokens,
    cacheWriteTokens: session.cacheWriteTokens + telemetry.cacheWriteTokens,
    responseTokens: session.responseTokens + telemetry.responseTokens,
    totalTokens: session.totalTokens + telemetry.totalTokens,
    estimatedCostUsd
  };
}
