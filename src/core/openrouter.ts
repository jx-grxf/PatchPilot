import type { ChatMessage, ModelChatOptions, ModelChatResult, ModelTelemetry } from "./types.js";
import { attachTokenCost } from "./tokenAccounting.js";

export const defaultOpenRouterModel = "openrouter/auto";
export const defaultOpenRouterBaseUrl = "https://openrouter.ai/api/v1";

type OpenRouterModel = {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: {
    prompt?: string;
    completion?: string;
    input_cache_read?: string;
    input_cache_write?: string;
  };
};

type OpenRouterModelsResponse = {
  data?: OpenRouterModel[];
  error?: {
    message?: string;
  };
};

type OpenRouterChatResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
      cache_write_tokens?: number;
    };
  };
  error?: {
    message?: string;
  };
};

type OpenRouterRuntimeOptions = {
  maxTokens: number;
  temperature: number;
};

const modelPricingCacheTtlMs = 15 * 60_000;
let modelPricingCache: {
  expiresAt: number;
  rates: Map<string, OpenRouterTokenRates>;
} | null = null;

export type OpenRouterTokenRates = {
  inputPerToken: number;
  cachedInputPerToken: number;
  cacheWritePerToken: number;
  outputPerToken: number;
};

export class OpenRouterClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly runtimeOptions: OpenRouterRuntimeOptions;

  constructor(
    apiKey = readOpenRouterApiKey(),
    baseUrl = process.env.PATCHPILOT_OPENROUTER_BASE_URL ?? defaultOpenRouterBaseUrl,
    runtimeOptions = readOpenRouterRuntimeOptions()
  ) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.runtimeOptions = runtimeOptions;
  }

  async chat(options: ModelChatOptions): Promise<ModelChatResult> {
    this.assertConfigured();
    const startedAt = Date.now();
    const response = await this.fetchOpenRouter("/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        "HTTP-Referer": "https://github.com/jx-grxf/PatchPilot",
        "X-Title": "PatchPilot"
      },
      body: JSON.stringify({
        model: normalizeOpenRouterModel(options.model),
        messages: options.messages,
        max_tokens: this.runtimeOptions.maxTokens,
        temperature: this.runtimeOptions.temperature,
        reasoning: options.reasoningEffort
          ? {
              effort: options.reasoningEffort,
              exclude: true
            }
          : undefined,
        response_format: options.formatJson ? { type: "json_object" } : undefined,
        usage: {
          include: true
        }
      }),
      signal: options.signal
    });
    const durationMs = Date.now() - startedAt;
    const payload = (await readJsonSafely(response)) as OpenRouterChatResponse;

    if (!response.ok || payload.error) {
      const reason = payload.error?.message ? ` ${payload.error.message}` : "";
      throw new Error(`OpenRouter chat failed for model "${options.model}": HTTP ${response.status}.${reason}`);
    }

    const content = payload.choices?.[0]?.message?.content?.trim() ?? "";
    if (!content) {
      throw new Error("OpenRouter returned an empty response.");
    }

    return {
      content,
      telemetry: await toTelemetry(payload, durationMs, options.model)
    };
  }

  async listModels(): Promise<string[]> {
    const models = await fetchOpenRouterModels(this.baseUrl);
    return [defaultOpenRouterModel, ...models.map((model) => model.id).sort()];
  }

  private async fetchOpenRouter(path: string, init?: RequestInit): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl}${path}`, init);
    } catch (error) {
      const suffix = error instanceof Error ? ` ${error.message}` : "";
      throw new Error(`Cannot reach OpenRouter API at ${this.baseUrl}.${suffix}`);
    }
  }

  private assertConfigured(): void {
    if (!this.apiKey) {
      throw new Error("OpenRouter API key missing. Set OPENROUTER_API_KEY in PatchPilot config, .env, or your shell.");
    }
  }
}

export function readOpenRouterApiKey(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENROUTER_API_KEY?.trim() || env.PATCHPILOT_OPENROUTER_API_KEY?.trim() || "";
}

export function isOpenRouterFreeModel(model: string): boolean {
  return normalizeOpenRouterModel(model).endsWith(":free");
}

export async function getOpenRouterModelRates(model: string): Promise<OpenRouterTokenRates | null> {
  const normalizedModel = normalizeOpenRouterModel(model);
  const rates = await readOpenRouterPricing();
  return rates.get(normalizedModel) ?? null;
}

function normalizeOpenRouterModel(model: string): string {
  const trimmedModel = model.trim();
  if (!trimmedModel || trimmedModel === "auto" || trimmedModel === "openrouter/auto") {
    return defaultOpenRouterModel;
  }

  return trimmedModel;
}

async function readOpenRouterPricing(): Promise<Map<string, OpenRouterTokenRates>> {
  if (modelPricingCache && modelPricingCache.expiresAt > Date.now()) {
    return modelPricingCache.rates;
  }

  const models = await fetchOpenRouterModels(process.env.PATCHPILOT_OPENROUTER_BASE_URL ?? defaultOpenRouterBaseUrl).catch(() => []);
  const rates = new Map<string, OpenRouterTokenRates>();
  for (const model of models) {
    rates.set(model.id, {
      inputPerToken: readPrice(model.pricing?.prompt),
      cachedInputPerToken: readPrice(model.pricing?.input_cache_read),
      cacheWritePerToken: readPrice(model.pricing?.input_cache_write),
      outputPerToken: readPrice(model.pricing?.completion)
    });
  }

  modelPricingCache = {
    expiresAt: Date.now() + modelPricingCacheTtlMs,
    rates
  };
  return rates;
}

async function fetchOpenRouterModels(baseUrl: string): Promise<OpenRouterModel[]> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models`);
  const payload = (await readJsonSafely(response)) as OpenRouterModelsResponse;
  if (!response.ok || payload.error) {
    const reason = payload.error?.message ? ` ${payload.error.message}` : "";
    throw new Error(`OpenRouter models failed with HTTP ${response.status}.${reason}`);
  }

  return payload.data ?? [];
}

async function toTelemetry(payload: OpenRouterChatResponse, durationMs: number, model: string): Promise<ModelTelemetry> {
  const promptTokens = payload.usage?.prompt_tokens ?? 0;
  const responseTokens = payload.usage?.completion_tokens ?? 0;
  const totalTokens = payload.usage?.total_tokens ?? promptTokens + responseTokens;
  const cachedPromptTokens = payload.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheWriteTokens = payload.usage?.prompt_tokens_details?.cache_write_tokens ?? 0;
  const rates = await getOpenRouterModelRates(model);

  return attachTokenCost(
    {
      promptTokens,
      cachedPromptTokens,
      cacheWriteTokens,
      responseTokens,
      totalTokens,
      evalTokensPerSecond: responseTokens > 0 && durationMs > 0 ? responseTokens / (durationMs / 1000) : null,
      promptDurationMs: 0,
      responseDurationMs: durationMs,
      totalDurationMs: durationMs,
      tokenSource: "provider"
    },
    "openrouter",
    model,
    rates,
    payload.usage?.cost
  );
}

function readOpenRouterRuntimeOptions(env: NodeJS.ProcessEnv = process.env): OpenRouterRuntimeOptions {
  return {
    maxTokens: readPositiveInteger(env.PATCHPILOT_NUM_PREDICT, 1024),
    temperature: readTemperature(env.PATCHPILOT_TEMPERATURE, 0.1)
  };
}

async function readJsonSafely(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function readPrice(value: string | undefined): number {
  const parsedValue = Number.parseFloat(value ?? "0");
  return Number.isFinite(parsedValue) && parsedValue >= 0 ? parsedValue : 0;
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsedValue = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : fallback;
}

function readTemperature(value: string | undefined, fallback: number): number {
  const parsedValue = Number.parseFloat(value ?? "");
  return Number.isFinite(parsedValue) && parsedValue >= 0 ? parsedValue : fallback;
}
