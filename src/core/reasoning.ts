import type { ModelProvider, ThinkingSetting } from "./types.js";

/**
 * Thinking is a model capability, not a PatchPilot abstraction.
 *
 * Earlier versions mapped a four-level "reasoning effort" scale onto every
 * provider, which mostly produced settings the model ignored. Local runtimes
 * expose exactly one meaningful control — whether the model thinks before it
 * answers — so that is all this module models. `"auto"` leaves the decision to
 * the runtime's own default.
 */

/** Families whose Ollama builds accept the `think` parameter. */
const thinkingCapablePattern = /gpt-oss|qwen3|deepseek-r1|deepseek-v3\.[1-9]|magistral|granite3\.\d+-dense/i;

/** gpt-oss takes a graded effort string rather than a boolean. */
const gradedThinkingPattern = /gpt-oss/i;

export function supportsThinking(provider: ModelProvider, model: string): boolean {
  if (provider === "ollama") {
    return thinkingCapablePattern.test(model);
  }

  // OpenAI-compatible servers expose no portable thinking switch; models that
  // reason do so on their own and stream it inline.
  return false;
}

/**
 * Resolves to Ollama's `think` parameter. `undefined` means "send nothing and
 * let the runtime decide", which is the correct default for models that have
 * no thinking mode at all.
 */
export function getOllamaThinkValue(
  model: string,
  requested: ThinkingSetting | undefined
): boolean | "low" | "medium" | "high" | undefined {
  if (!requested || requested === "auto" || !thinkingCapablePattern.test(model)) {
    return undefined;
  }

  if (gradedThinkingPattern.test(model)) {
    // gpt-oss cannot be fully silenced; "off" falls back to the lowest effort.
    return requested === "off" ? "low" : "high";
  }

  return requested === "on";
}

export function formatThinkingSupport(provider: ModelProvider, model: string, requested: ThinkingSetting | undefined): string {
  if (!supportsThinking(provider, model)) {
    return `${model} has no thinking mode; using model default`;
  }

  if (!requested || requested === "auto") {
    return "model default";
  }

  if (requested === "off" && gradedThinkingPattern.test(model)) {
    return "gpt-oss thinking cannot be fully disabled; using lowest effort";
  }

  return `thinking ${requested}`;
}
