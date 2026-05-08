import type { ModelProvider, ReasoningEffort } from "./types.js";

export type ReasoningSetting = ReasoningEffort | "none";

export function resolveProviderReasoning(options: {
  provider: ModelProvider;
  model: string;
  requested: ReasoningSetting | undefined;
}): ReasoningSetting | undefined {
  if (!options.requested) {
    return undefined;
  }

  if (options.provider === "ollama") {
    return getOllamaThinkValue(options.model, options.requested) === undefined ? undefined : options.requested;
  }

  if (options.provider === "nvidia") {
    return supportsNvidiaReasoningEffort(options.model) && options.requested !== "none" ? clampReasoningEffort(options.requested, "high") : undefined;
  }

  if (options.provider === "gemini") {
    return getGeminiThinkingConfig(options.model, options.requested) === undefined ? undefined : options.requested;
  }

  if (options.provider === "codex") {
    return options.requested === "none" ? undefined : options.requested;
  }

  return options.requested;
}

export function getGeminiThinkingConfig(model: string, requested: ReasoningSetting | undefined): Record<string, unknown> | undefined {
  if (!requested) {
    return undefined;
  }

  const normalizedModel = model.toLowerCase();
  if (requested === "none") {
    return /gemini-2\.5-(flash|flash-lite)/i.test(normalizedModel)
      ? {
          thinkingBudget: 0
        }
      : undefined;
  }

  if (/gemini-2\.5/i.test(normalizedModel)) {
    return {
      thinkingBudget: reasoningBudget(requested)
    };
  }

  if (/gemini-3/i.test(normalizedModel)) {
    return {
      thinkingLevel: requested === "xhigh" ? "high" : requested
    };
  }

  return undefined;
}

export function getOpenRouterReasoningConfig(requested: ReasoningSetting | undefined): Record<string, unknown> | undefined {
  return requested
    ? {
        effort: requested,
        exclude: true
      }
    : undefined;
}

export function getOllamaThinkValue(model: string, requested: ReasoningSetting | undefined): boolean | "low" | "medium" | "high" | undefined {
  if (!requested) {
    return undefined;
  }

  const normalizedModel = model.toLowerCase();
  if (/gpt-oss/.test(normalizedModel)) {
    return requested === "none" ? undefined : clampReasoningEffort(requested, "high");
  }

  if (/qwen3|deepseek-r1|deepseek-v3\.1/.test(normalizedModel)) {
    return requested === "none" ? false : true;
  }

  return undefined;
}

export function getNvidiaReasoningEffort(model: string, requested: ReasoningSetting | undefined): "low" | "medium" | "high" | undefined {
  if (!requested || requested === "none" || !supportsNvidiaReasoningEffort(model)) {
    return undefined;
  }

  return clampReasoningEffort(requested, "high");
}

export function formatReasoningSupport(provider: ModelProvider, model: string, requested: ReasoningSetting | undefined): string {
  const resolved = resolveProviderReasoning({
    provider,
    model,
    requested
  });

  if (!requested) {
    return "provider default";
  }

  if (!resolved) {
    return `${requested} not supported by ${provider} for ${model}; using provider default`;
  }

  if (provider === "gemini" && requested === "none" && !/gemini-2\.5-(flash|flash-lite)/i.test(model)) {
    return "Gemini thinking cannot be disabled for this model; using provider default";
  }

  if (provider === "ollama" && /gpt-oss/i.test(model) && requested === "none") {
    return "gpt-oss reasoning cannot be fully disabled in Ollama; using provider default";
  }

  return `${provider} reasoning ${resolved}`;
}

function reasoningBudget(effort: ReasoningEffort): number {
  if (effort === "low") {
    return 512;
  }

  if (effort === "medium") {
    return 2048;
  }

  if (effort === "high") {
    return 8192;
  }

  return 12_288;
}

function clampReasoningEffort(effort: ReasoningEffort, xhighFallback: "high"): "low" | "medium" | "high" {
  return effort === "xhigh" ? xhighFallback : effort;
}

function supportsNvidiaReasoningEffort(model: string): boolean {
  return /gpt-oss-(20b|120b)|gpt-oss/i.test(model.toLowerCase());
}
