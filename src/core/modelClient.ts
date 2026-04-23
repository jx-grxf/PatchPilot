import { GeminiClient } from "./gemini.js";
import { OllamaClient } from "./ollama.js";
import type { ModelClient, ModelProvider } from "./types.js";

export function createModelClient(options: {
  provider: ModelProvider;
  ollamaUrl: string;
}): ModelClient {
  if (options.provider === "gemini") {
    return new GeminiClient();
  }

  return new OllamaClient(options.ollamaUrl);
}

export function readModelProvider(env: NodeJS.ProcessEnv = process.env): ModelProvider {
  return normalizeModelProvider(env.PATCHPILOT_PROVIDER ?? env.PATCHPILOT_MODEL_PROVIDER ?? "ollama");
}

export function normalizeModelProvider(value: string): ModelProvider {
  const normalizedValue = value.trim().toLowerCase();
  if (normalizedValue === "gemini" || normalizedValue === "google") {
    return "gemini";
  }

  return "ollama";
}
