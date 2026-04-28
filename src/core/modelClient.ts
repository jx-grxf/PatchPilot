import { CodexCliClient } from "./codex.js";
import { GeminiClient } from "./gemini.js";
import { OllamaClient } from "./ollama.js";
import { OpenRouterClient } from "./openrouter.js";
import type { ModelClient, ModelProvider } from "./types.js";

export function createModelClient(options: {
  provider: ModelProvider;
  ollamaUrl: string;
  workspace?: string;
}): ModelClient {
  if (options.provider === "gemini") {
    return new GeminiClient();
  }

  if (options.provider === "codex") {
    return new CodexCliClient({
      workspace: options.workspace ?? process.cwd()
    });
  }

  if (options.provider === "openrouter") {
    return new OpenRouterClient();
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

  if (normalizedValue === "codex" || normalizedValue === "openai" || normalizedValue === "openai-codex") {
    return "codex";
  }

  if (normalizedValue === "openrouter" || normalizedValue === "open-router") {
    return "openrouter";
  }

  return "ollama";
}
