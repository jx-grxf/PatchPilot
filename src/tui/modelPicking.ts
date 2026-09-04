import { defaultLocalOpenAIModel } from "../core/localOpenAI.js";
import { defaultOllamaModel, OllamaClient } from "../core/ollama.js";
import type { ModelProvider } from "../core/types.js";
import { modelDescriptorIndex } from "./modelRuntime.js";
import { formatModelLabel, formatModelOptions, selectableModels } from "./modelSelection.js";
import { normalizeModelAlias } from "./format.js";
import type { AgentRunnerOptions } from "../core/agent.js";
import type { OllamaHostDetails } from "./hosts.js";
import type { LogLineInput } from "./types.js";

/**
 * Choosing and validating a model id.
 *
 * Ollama can only run what it has pulled, so an unlisted id is always wrong.
 * An OpenAI-compatible server may load one on demand, so a plausible id there
 * is worth attempting rather than refusing.
 */

export function selectModelFromInput(value: string, models: string[], selectedIndex?: number, options: { allowManual?: boolean } = {}): string | null {
  const normalizedValue = normalizeModelAlias(value.trim());
  if (!normalizedValue && selectedIndex !== undefined) {
    return models[selectedIndex] ?? null;
  }

  if (!normalizedValue) {
    return null;
  }

  const modelIndex = Number.parseInt(normalizedValue, 10);
  if (Number.isInteger(modelIndex)) {
    return models[modelIndex - 1] ?? null;
  }

  if (models.includes(normalizedValue)) {
    return normalizedValue;
  }

  const labelMatch = models.find((model) => formatModelLabel(model).toLowerCase() === normalizedValue.toLowerCase());
  if (labelMatch) {
    return labelMatch;
  }

  const matches = selectableModels(normalizedValue, models, formatModelLabel);
  if (matches.length === 1) {
    return matches[0] ?? null;
  }

  return options.allowManual && isPlausibleCloudModelId(normalizedValue) ? normalizedValue : null;
}

export function isPlausibleCloudModelId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(value) && value.length >= 3;
}

/**
 * Ollama can only run what it has pulled, so an unlisted id is always wrong.
 * An OpenAI-compatible server may load a model on demand, so a plausible id is
 * worth attempting rather than refusing.
 */
export function canUseUnverifiedModel(provider: ModelProvider, model: string): boolean {
  return provider !== "ollama" && isPlausibleCloudModelId(model);
}

export function defaultModelForProvider(provider: ModelProvider, currentModel: string): string {
  if (provider === "local-openai") {
    return modelDescriptorIndex.has(currentModel) ? currentModel : defaultLocalOpenAIModel;
  }

  return currentModel.includes("/") ? defaultOllamaModel : currentModel;
}


export async function unloadUsedOllamaModels(usedModels: Set<string>): Promise<void> {
  const entries = [...usedModels];
  usedModels.clear();
  await Promise.allSettled(
    entries.map(async (entry) => {
      const [url, model] = entry.split("|");
      if (!url || !model) {
        return;
      }

      await new OllamaClient(url).unloadModel(model);
    })
  );
}

export async function ejectOllamaModels(options: {
  target: string;
  settings: AgentRunnerOptions;
  activeHost: OllamaHostDetails | null;
  usedModels: Set<string>;
}): Promise<string[]> {
  const target = options.target.trim();
  const client = new OllamaClient(options.settings.ollamaUrl);
  const models =
    target === "all"
      ? [
          ...new Set([
            ...[...options.usedModels]
              .map((entry) => entry.split("|"))
              .filter(([url]) => url === options.settings.ollamaUrl)
              .map(([, model]) => model)
              .filter((model): model is string => Boolean(model)),
            ...(options.activeHost?.runningModels.map((model) => model.name) ?? [])
          ])
        ]
      : [target || options.settings.model];

  const ejected: string[] = [];
  for (const model of models) {
    await client.unloadModel(model).then(
      () => {
        ejected.push(model);
        options.usedModels.delete(`${options.settings.ollamaUrl}|${model}`);
      },
      () => undefined
    );
  }

  return ejected;
}
