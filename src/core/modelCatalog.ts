import { LocalOpenAIClient } from "./localOpenAI.js";
import { localRuntimeOrder, localRuntimes, supportsMlx, type LocalRuntime, type LocalRuntimeId } from "./localRuntimes.js";
import { OllamaClient } from "./ollama.js";
import type { ModelProvider } from "./types.js";

/**
 * One view of every model available on this machine, across every local
 * runtime that is actually running.
 *
 * Someone with Ollama, LM Studio and an MLX server up has three separate model
 * lists and no way to compare them. The catalog merges them, reports what each
 * runtime says about load state and context length, and — crucially — reports
 * the *real* context window rather than the `num_ctx` the harness happens to
 * send, because those diverge and only one of them is true.
 */

export type CatalogModel = {
  id: string;
  runtime: LocalRuntimeId;
  runtimeLabel: string;
  provider: ModelProvider;
  baseUrl: string;
  /** Loaded and ready, versus known but cold. Null when the runtime does not say. */
  loaded: boolean | null;
  /** Real context window, when the runtime reports one. */
  contextLength: number | null;
  /** Vision, embeddings, and so on, where the runtime distinguishes them. */
  kind: string | null;
  sizeBytes: number | null;
};

export type RuntimeStatus = {
  runtime: LocalRuntime;
  reachable: boolean;
  models: CatalogModel[];
  /** Why it is not reachable, or why it was not tried at all. */
  detail: string;
};

export type ModelCatalog = {
  runtimes: RuntimeStatus[];
  models: CatalogModel[];
};

/**
 * Probes every known runtime in parallel. A runtime that is not running is a
 * normal outcome, not an error — most machines run one or two of these.
 */
export async function discoverModels(
  options: {
    /** Override a runtime's endpoint, e.g. a LAN Ollama host. */
    baseUrls?: Partial<Record<LocalRuntimeId, string>>;
    signal?: AbortSignal;
  } = {}
): Promise<ModelCatalog> {
  const statuses = await Promise.all(
    localRuntimeOrder.map((id) => probeRuntime(localRuntimes[id], options.baseUrls?.[id], options.signal))
  );

  return {
    runtimes: statuses,
    models: statuses.flatMap((status) => status.models)
  };
}

async function probeRuntime(runtime: LocalRuntime, baseUrlOverride: string | undefined, signal?: AbortSignal): Promise<RuntimeStatus> {
  if (runtime.appleSiliconOnly && !supportsMlx()) {
    return {
      runtime,
      reachable: false,
      models: [],
      detail: "MLX runs only on Apple Silicon"
    };
  }

  const baseUrl = baseUrlOverride ?? runtime.defaultBaseUrl;
  try {
    const models = runtime.provider === "ollama" ? await listOllama(runtime, baseUrl) : await listOpenAICompatible(runtime, baseUrl, signal);
    return {
      runtime,
      reachable: true,
      models,
      detail: models.length > 0 ? `${models.length} model${models.length === 1 ? "" : "s"}` : "reachable, no models served"
    };
  } catch (error) {
    return {
      runtime,
      reachable: false,
      models: [],
      detail: process.env.PATCHPILOT_DEBUG && error instanceof Error
        ? `not running (${error.message}). ${runtime.startHint}`
        : `not running. ${runtime.startHint}`
    };
  }
}

async function listOllama(runtime: LocalRuntime, baseUrl: string): Promise<CatalogModel[]> {
  const client = new OllamaClient(baseUrl);
  const [names, running] = await Promise.all([client.listModels(), client.listRunningModels().catch(() => [])]);
  const runningByName = new Map(running.map((model) => [model.name, model]));

  return names.map((id) => {
    const loaded = runningByName.get(id);
    return {
      id,
      runtime: runtime.id,
      runtimeLabel: runtime.label,
      provider: runtime.provider,
      baseUrl,
      loaded: Boolean(loaded),
      contextLength: loaded?.contextLength ?? null,
      kind: null,
      sizeBytes: loaded?.sizeBytes ?? null
    };
  });
}

async function listOpenAICompatible(runtime: LocalRuntime, baseUrl: string, signal?: AbortSignal): Promise<CatalogModel[]> {
  const descriptors = await new LocalOpenAIClient(baseUrl).listModelDescriptors();
  void signal;

  return descriptors.map((descriptor) => ({
    id: descriptor.id,
    runtime: runtime.id,
    runtimeLabel: runtime.label,
    provider: runtime.provider,
    baseUrl,
    loaded: descriptor.isAvailable ?? null,
    contextLength: descriptor.capacity ?? null,
    kind: readKind(descriptor.description),
    sizeBytes: null
  }));
}

function readKind(description: string | undefined): string | null {
  if (!description) {
    return null;
  }

  const match = /type[:=]\s*([\w-]+)/i.exec(description);
  return match?.[1] ?? null;
}

/**
 * Models that cannot do the job, filtered out before a user can pick one.
 * An embedding model in a chat model picker is not a choice, it is a trap —
 * and on a server with just-in-time loading it silently answers with something
 * else entirely.
 */
export function isUsableForChat(model: CatalogModel): boolean {
  if (model.kind && /embed/i.test(model.kind)) {
    return false;
  }

  return !/embed|bge-|e5-|gte-|reranker|whisper|clip-/i.test(model.id);
}

/**
 * Ranks models by how well they suit an agent loop: already loaded first
 * (loading a 27B model costs more than the whole task), then by context
 * window, then by name for a stable order.
 */
export function rankForAgentUse(models: CatalogModel[]): CatalogModel[] {
  return [...models].sort((left, right) => {
    if (left.loaded !== right.loaded) {
      return left.loaded ? -1 : 1;
    }

    const leftContext = left.contextLength ?? 0;
    const rightContext = right.contextLength ?? 0;
    if (leftContext !== rightContext) {
      return rightContext - leftContext;
    }

    return left.id.localeCompare(right.id);
  });
}

/** Human-readable one-liner for a catalog row. */
export function describeModel(model: CatalogModel): string {
  const parts = [model.runtimeLabel];
  if (model.loaded === true) {
    parts.push("loaded");
  } else if (model.loaded === false) {
    parts.push("not loaded");
  }
  if (model.contextLength) {
    parts.push(`${formatContext(model.contextLength)} ctx`);
  }
  if (model.kind) {
    parts.push(model.kind);
  }

  return parts.join(" · ");
}

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  }

  if (tokens >= 1000) {
    return `${Math.round(tokens / 1000)}k`;
  }

  return String(tokens);
}
