import { LocalOpenAIClient, resolveLocalOpenAIBaseUrl } from "./localOpenAI.js";
import { OllamaClient } from "./ollama.js";
import type { ModelClient, ModelProvider } from "./types.js";

export function createModelClient(options: {
  provider: ModelProvider;
  ollamaUrl: string;
  localUrl?: string;
  workspace?: string;
}): ModelClient {
  if (options.provider === "local-openai") {
    return new LocalOpenAIClient(options.localUrl ?? resolveLocalOpenAIBaseUrl());
  }

  return new OllamaClient(options.ollamaUrl);
}

export function readModelProvider(env: NodeJS.ProcessEnv = process.env): ModelProvider {
  return normalizeModelProvider(env.PATCHPILOT_PROVIDER ?? env.PATCHPILOT_MODEL_PROVIDER ?? "ollama");
}

/**
 * Aliases cover the runtimes that all speak the same OpenAI-compatible
 * surface, so `--provider lmstudio` and `--provider llamacpp` land on one
 * client rather than implying separate implementations.
 */
export function normalizeModelProvider(value: string): ModelProvider {
  const normalizedValue = value.trim().toLowerCase();
  if (
    normalizedValue === "local-openai" ||
    normalizedValue === "local" ||
    normalizedValue === "openai-compatible" ||
    normalizedValue === "lmstudio" ||
    normalizedValue === "lm-studio" ||
    normalizedValue === "bionic" ||
    normalizedValue === "llamacpp" ||
    normalizedValue === "llama.cpp" ||
    normalizedValue === "mlx" ||
    normalizedValue === "mlx-lm" ||
    normalizedValue === "vllm"
  ) {
    return "local-openai";
  }

  return "ollama";
}
