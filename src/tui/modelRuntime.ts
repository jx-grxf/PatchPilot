import type { AgentRunnerOptions } from "../core/agent.js";
import { createModelClient } from "../core/modelClient.js";
import { resolveLocalOpenAIBaseUrl } from "../core/localOpenAI.js";
import type { ModelDescriptor, ModelProvider, ModelTelemetry } from "../core/types.js";
import { savePatchPilotEnvValues } from "../core/env.js";
import { formatModelLabel, formatModelOptions, selectableModels } from "./modelSelection.js";
import { canUseUnverifiedModel, selectModelFromInput } from "./modelPicking.js";
import type { LogLineInput } from "./types.js";

/**
 * Discovering, caching and switching the active model.
 *
 * The cache exists because listing models hits the runtime over HTTP and the
 * palette asks for the list on every keystroke.
 */

const modelCacheTtlMs = 5 * 60_000;
const modelCache = new Map<string, { models: string[]; descriptors: ModelDescriptor[]; expiresAt: number }>();
export const modelDescriptorIndex = new Map<string, ModelDescriptor>();

/** Seeds the cache from a host probe that already listed the models. */
export function cacheModelList(
  provider: ModelProvider,
  ollamaUrl: string,
  models: string[],
  descriptors: ModelDescriptor[]
): void {
  modelCache.set(modelCacheKey(provider, ollamaUrl), {
    models,
    descriptors,
    expiresAt: Date.now() + modelCacheTtlMs
  });
}

export async function loadAvailableModels(
  provider: ModelProvider,
  ollamaUrl: string,
  setModelOptions: React.Dispatch<React.SetStateAction<string[]>>,
  refresh = false
): Promise<string[]> {
  const cacheKey = modelCacheKey(provider, ollamaUrl);
  const cachedModels = modelCache.get(cacheKey);
  if (!refresh && cachedModels && cachedModels.expiresAt > Date.now()) {
    rememberModelDescriptors(cachedModels.descriptors);
    setModelOptions(cachedModels.models);
    return cachedModels.models;
  }

  const client = createModelClient({
    provider,
    ollamaUrl
  });
  const descriptors = client.listModelDescriptors
    ? await client.listModelDescriptors()
    : (await client.listModels()).map((model) => ({ id: model, displayName: model }));
  const models = descriptors.map((model) => model.id);
  rememberModelDescriptors(descriptors);
  modelCache.set(cacheKey, {
    models,
    descriptors,
    expiresAt: Date.now() + modelCacheTtlMs
  });
  setModelOptions(models);
  return models;
}

export function modelCacheKey(provider: ModelProvider, ollamaUrl: string): string {
  if (provider === "ollama") {
    return `${provider}:${ollamaUrl}`;
  }

  return `${provider}:${resolveLocalOpenAIBaseUrl()}`;
}

export function rememberModelDescriptors(descriptors: ModelDescriptor[]): void {
  for (const descriptor of descriptors) {
    modelDescriptorIndex.set(descriptor.id, descriptor);
    if (descriptor.modelName) {
      modelDescriptorIndex.set(descriptor.modelName, descriptor);
    }
    if (descriptor.displayName) {
      modelDescriptorIndex.set(descriptor.displayName, descriptor);
    }
  }
}

export async function loadKnownOrAvailableModels(
  provider: ModelProvider,
  ollamaUrl: string,
  modelOptions: string[],
  setModelOptions: React.Dispatch<React.SetStateAction<string[]>>,
  appendLine: (line: LogLineInput) => void,
  options: {
    refresh?: boolean;
  } = {}
): Promise<string[] | null> {
  try {
    return !options.refresh && modelOptions.length > 0 ? modelOptions : await loadAvailableModels(provider, ollamaUrl, setModelOptions, options.refresh);
  } catch (error) {
    appendLine({
      tone: "danger",
      label: "models",
      text: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

export async function switchModel(
  provider: ModelProvider,
  nextModel: string,
  ollamaUrl: string,
  currentModel: string,
  appendLine: (line: LogLineInput) => void,
  setModelOptions: React.Dispatch<React.SetStateAction<string[]>>,
  setSettings: React.Dispatch<React.SetStateAction<AgentRunnerOptions>>,
  setTelemetry: React.Dispatch<React.SetStateAction<ModelTelemetry | null>>,
  knownModels?: string[]
): Promise<void> {
  const installedModels =
    knownModels ??
    (await loadAvailableModels(provider, ollamaUrl, setModelOptions).catch((error: unknown) => {
      appendLine({
        tone: "danger",
        label: "models",
        text: error instanceof Error ? error.message : String(error)
      });
      return null;
    }));

  if (!installedModels) {
    return;
  }

  if (!installedModels.includes(nextModel) && !canUseUnverifiedModel(provider, nextModel)) {
    appendLine({
      tone: "warning",
      label: "model",
      text: `${nextModel} is not available for ${provider}.`,
      detail:
        installedModels.length > 0
          ? `Use /models and pick one of:\n${formatModelOptions(installedModels, currentModel)}`
          : provider === "ollama"
            ? "No models installed on the selected host."
            : "No models served. Load one in your local server, or check PATCHPILOT_LOCAL_URL."
    });
    return;
  }

  setTelemetry(null);
  setSettings((currentSettings) => ({
    ...currentSettings,
    model: nextModel
  }));
  savePatchPilotEnvValues({
    PATCHPILOT_PROVIDER: provider,
    PATCHPILOT_MODEL: nextModel
  });
  appendLine({
    tone: installedModels.includes(nextModel) ? "success" : "warning",
    label: "model",
    text: installedModels.includes(nextModel) ? `switched to ${formatModelLabel(nextModel)}` : `switched to unverified ${provider} model ${nextModel}`,
    detail: installedModels.includes(nextModel) ? undefined : "The provider did not list this model in discovery. PatchPilot will try it and surface the provider error if it is unavailable."
  });
}

export async function resolveRunnableSettings(
  settings: AgentRunnerOptions,
  modelOptions: string[],
  appendLine: (line: LogLineInput) => void,
  setModelOptions: React.Dispatch<React.SetStateAction<string[]>>,
  onProviderError?: (message: string) => void
): Promise<AgentRunnerOptions | null> {
  let installedModels: string[];
  try {
    installedModels = modelOptions.includes(settings.model)
      ? modelOptions
      : await loadAvailableModels(settings.provider, settings.ollamaUrl, setModelOptions);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendLine({
      tone: "danger",
      label: settings.provider,
      text: message
    });
    onProviderError?.(message);
    return null;
  }

  if (installedModels.includes(settings.model) || canUseUnverifiedModel(settings.provider, settings.model)) {
    if (!installedModels.includes(settings.model)) {
      appendLine({
        tone: "warning",
        label: "model",
        text: `using unverified ${settings.provider} model ${settings.model}`,
        detail: "Model discovery did not list it; the next provider request will be the compatibility check."
      });
    }
    return settings;
  }

  appendLine({
    tone: "warning",
    label: "model",
    text: `${settings.model} is not available for ${settings.provider}.`,
    detail:
      installedModels.length > 0
        ? `Pick an installed model first:\n${formatModelOptions(installedModels, settings.model)}`
        : settings.provider === "ollama"
          ? "No models installed on the selected host."
          : "No models served. Load one in your local server, or check PATCHPILOT_LOCAL_URL."
  });
  return null;
}
