import type { ModelChatOptions, ModelChatResult, ModelTelemetry } from "./types.js";
import { fetchWithTimeout } from "./http.js";
import { attachTokenCost } from "./tokenAccounting.js";

export const defaultGeminiWrapperModel = "gemini-2.5-flash";

type GeminiWrapperModelsResponse = {
  data?: Array<{
    id?: string;
  }>;
  error?: {
    message?: string;
  };
};

type GeminiWrapperChatResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
      cache_write_tokens?: number;
    };
  };
  error?: {
    message?: string;
  };
};

type GeminiWrapperRuntimeOptions = {
  maxTokens: number;
  temperature: number;
};

export class GeminiWrapperClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly runtimeOptions: GeminiWrapperRuntimeOptions;

  constructor(
    baseUrl = readGeminiWrapperBaseUrl(),
    apiKey = readGeminiWrapperApiKey(),
    runtimeOptions = readGeminiWrapperRuntimeOptions()
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.runtimeOptions = runtimeOptions;
  }

  async chat(options: ModelChatOptions): Promise<ModelChatResult> {
    this.assertConfigured();
    const startedAt = Date.now();
    const response = await this.fetchGeminiWrapper("/chat/completions", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(cleanUndefined({
        model: normalizeGeminiWrapperModel(options.model),
        messages: options.messages,
        max_tokens: this.runtimeOptions.maxTokens,
        temperature: this.runtimeOptions.temperature,
        response_format: options.formatJson ? { type: "json_object" } : undefined
      })),
      signal: options.signal
    });
    const durationMs = Date.now() - startedAt;
    const payload = (await readJsonSafely(response)) as GeminiWrapperChatResponse;

    if (!response.ok || payload.error) {
      const reason = payload.error?.message ? ` ${payload.error.message}` : "";
      if (response.status === 401 || response.status === 403) {
        throw new Error("Gemini-Wrapper authentication failed. Check PATCHPILOT_GEMINI_WRAPPER_API_KEY.");
      }
      if (response.status === 429) {
        throw new Error(`Gemini-Wrapper rate limit hit for model "${options.model}".${reason}`);
      }
      throw new Error(`Gemini-Wrapper chat failed for model "${options.model}": HTTP ${response.status}.${reason}`);
    }

    const content = payload.choices?.[0]?.message?.content?.trim() ?? "";
    if (!content) {
      throw new Error("Gemini-Wrapper returned an empty response.");
    }

    return {
      content,
      telemetry: toTelemetry(payload, durationMs, options.model)
    };
  }

  async listModels(): Promise<string[]> {
    this.assertConfigured();
    const response = await this.fetchGeminiWrapper("/models", {
      headers: this.headers()
    });
    const payload = (await readJsonSafely(response)) as GeminiWrapperModelsResponse;
    if (!response.ok || payload.error) {
      const reason = payload.error?.message ? ` ${payload.error.message}` : "";
      throw new Error(`Gemini-Wrapper models failed with HTTP ${response.status}.${reason}`);
    }

    const models = [
      ...new Set(
        payload.data
          ?.map((model) => model.id?.trim())
          .filter((model): model is string => Boolean(model))
          .filter(isLikelyGeminiWrapperChatModel) ?? []
      )
    ].sort();
    return models.length > 0 ? models : [defaultGeminiWrapperModel];
  }

  private async fetchGeminiWrapper(path: string, init?: RequestInit): Promise<Response> {
    try {
      return await fetchWithTimeout(`${this.baseUrl}${path}`, init, {
        timeoutMs: init?.method === "POST" ? 90_000 : 8000,
        retries: init?.method === "POST" ? 0 : 1,
        label: `Gemini-Wrapper ${path}`
      });
    } catch (error) {
      const suffix = error instanceof Error ? ` ${error.message}` : "";
      throw new Error(`Cannot reach Gemini-Wrapper API at ${this.baseUrl}.${suffix}`);
    }
  }

  private headers(): HeadersInit {
    return cleanUndefined({
      "Content-Type": "application/json",
      Authorization: this.apiKey ? `Bearer ${this.apiKey}` : undefined
    }) as HeadersInit;
  }

  private assertConfigured(): void {
    if (!this.baseUrl) {
      throw new Error(
        "Gemini-Wrapper requires an explicit OpenAI-compatible wrapper URL. Set PATCHPILOT_GEMINI_WRAPPER_BASE_URL. PatchPilot does not collect browser cookies or reuse web login sessions."
      );
    }

    if (geminiWrapperRequiresApiKey(this.baseUrl) && !this.apiKey) {
      throw new Error(
        "Gemini-Wrapper remote URLs require an explicit API key. Set PATCHPILOT_GEMINI_WRAPPER_API_KEY or GEMINI_WRAPPER_API_KEY. PatchPilot does not collect browser cookies."
      );
    }
  }
}

export function readGeminiWrapperBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.PATCHPILOT_GEMINI_WRAPPER_BASE_URL?.trim() || "";
}

export function readGeminiWrapperApiKey(env: NodeJS.ProcessEnv = process.env): string {
  return env.PATCHPILOT_GEMINI_WRAPPER_API_KEY?.trim() || env.GEMINI_WRAPPER_API_KEY?.trim() || "";
}

export function geminiWrapperRequiresApiKey(baseUrl: string): boolean {
  return !isLocalWrapperUrl(baseUrl);
}

function isLocalWrapperUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]";
  } catch {
    return false;
  }
}

function normalizeGeminiWrapperModel(model: string): string {
  const trimmedModel = model.trim();
  return trimmedModel || defaultGeminiWrapperModel;
}

function isLikelyGeminiWrapperChatModel(model: string): boolean {
  const normalizedModel = model.toLowerCase();
  return !/(embedding|embed|imagen|veo|tts|audio|speech|rerank|rank|vision|bidi|live)/.test(normalizedModel);
}

function readGeminiWrapperRuntimeOptions(env: NodeJS.ProcessEnv = process.env): GeminiWrapperRuntimeOptions {
  return {
    maxTokens: readPositiveInteger(env.PATCHPILOT_NUM_PREDICT, 1024),
    temperature: readTemperature(env.PATCHPILOT_TEMPERATURE, 0.1)
  };
}

function toTelemetry(payload: GeminiWrapperChatResponse, durationMs: number, model: string): ModelTelemetry {
  const promptTokens = payload.usage?.prompt_tokens ?? 0;
  const responseTokens = payload.usage?.completion_tokens ?? 0;
  return attachTokenCost(
    {
      promptTokens,
      cachedPromptTokens: payload.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      cacheWriteTokens: payload.usage?.prompt_tokens_details?.cache_write_tokens ?? 0,
      responseTokens,
      totalTokens: payload.usage?.total_tokens ?? promptTokens + responseTokens,
      evalTokensPerSecond: responseTokens > 0 && durationMs > 0 ? responseTokens / (durationMs / 1000) : null,
      promptDurationMs: 0,
      responseDurationMs: durationMs,
      totalDurationMs: durationMs,
      tokenSource: "provider"
    },
    "gemini-wrapper",
    model
  );
}

function cleanUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

async function readJsonSafely(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsedValue = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : fallback;
}

function readTemperature(value: string | undefined, fallback: number): number {
  const parsedValue = Number.parseFloat(value ?? "");
  return Number.isFinite(parsedValue) && parsedValue >= 0 ? parsedValue : fallback;
}
