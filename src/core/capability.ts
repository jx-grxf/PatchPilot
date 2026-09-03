import { toProviderTools, toolDefinitions } from "./toolSchema.js";
import type { ModelClient, ModelProvider } from "./types.js";

/**
 * Whether a given model can actually drive native tool calling.
 *
 * Advertising tools to a model that ignores them is worse than not advertising
 * at all: the model answers in prose, the loop sees no calls, and the run
 * stalls looking like a refusal. Rather than maintaining a list of model
 * families — which goes stale every few weeks — the harness asks the model
 * once and remembers the answer.
 *
 * Ollama's schema adherence is also known to vary by family, so the probe is
 * per model, never a global flag.
 */

export type ModelCapabilities = {
  /** The model emitted a well-formed native tool call when asked to. */
  nativeToolCalls: boolean;
  /** Why the harness believes that, for /doctor and the transcript. */
  detail: string;
};

const probeCache = new Map<string, Promise<ModelCapabilities>>();

/** A deliberately trivial task: any model that can call a tool will call this one. */
const probeTool = toProviderTools([toolDefinitions.read]);

export function capabilityCacheKey(provider: ModelProvider, model: string): string {
  return `${provider}:${model}`;
}

/**
 * Probes once per model per session and caches the promise, so concurrent
 * callers share a single request rather than racing.
 */
export function probeModelCapabilities(options: {
  client: ModelClient;
  provider: ModelProvider;
  model: string;
  signal?: AbortSignal;
}): Promise<ModelCapabilities> {
  const key = capabilityCacheKey(options.provider, options.model);
  const cached = probeCache.get(key);
  if (cached) {
    return cached;
  }

  const probe = runProbe(options).catch((error): ModelCapabilities => {
    // A probe that fails to connect says nothing about the model, so fall back
    // to the envelope rather than caching a wrong "unsupported".
    probeCache.delete(key);
    return {
      nativeToolCalls: false,
      detail: `probe failed: ${error instanceof Error ? error.message : String(error)}`
    };
  });

  probeCache.set(key, probe);
  return probe;
}

async function runProbe(options: {
  client: ModelClient;
  provider: ModelProvider;
  model: string;
  signal?: AbortSignal;
}): Promise<ModelCapabilities> {
  const result = await options.client.chat({
    model: options.model,
    messages: [
      {
        role: "system",
        content: "You are a tool-calling assistant. Use the provided tool. Do not answer in prose."
      },
      {
        role: "user",
        content: "Read the file README.md."
      }
    ],
    tools: probeTool,
    signal: options.signal
  });

  // An answer from a substituted model says nothing about the model that was
  // asked for, and caching it under the requested id would be a lie.
  if (result.warning) {
    return { nativeToolCalls: false, detail: result.warning };
  }

  const call = result.toolCalls?.[0];
  if (!call) {
    return {
      nativeToolCalls: false,
      detail: "model answered in prose when a tool call was the only sensible reply"
    };
  }

  if (typeof call.name !== "string" || call.name.trim() === "") {
    return { nativeToolCalls: false, detail: "model emitted a tool call with no name" };
  }

  return { nativeToolCalls: true, detail: `native tool calls confirmed (${call.name})` };
}

/** Test seam and `/model` switch hook: forget what was learned about a model. */
export function clearCapabilityCache(provider?: ModelProvider, model?: string): void {
  if (provider && model) {
    probeCache.delete(capabilityCacheKey(provider, model));
    return;
  }

  probeCache.clear();
}

/** Pre-seeds the cache, used by tests and by an explicit user override. */
export function setModelCapabilities(provider: ModelProvider, model: string, capabilities: ModelCapabilities): void {
  probeCache.set(capabilityCacheKey(provider, model), Promise.resolve(capabilities));
}
