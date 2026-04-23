import type { ModelChatOptions, ModelChatResult, ModelTelemetry } from "./types.js";
import { attachTokenCost } from "./tokenAccounting.js";

export const defaultOllamaModel = "qwen2.5-coder:7b";
export const defaultOllamaUrl = "http://127.0.0.1:11434";
export const defaultOllamaPort = 11434;

type OllamaChatResponse = {
  message?: {
    content?: string;
  };
  error?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
};

type OllamaTagsResponse = {
  models?: Array<{
    name: string;
  }>;
};

type OllamaRuntimeOptions = {
  keepAlive: string;
  numCtx: number;
  numPredict: number;
  temperature: number;
};

export class OllamaClient {
  private readonly baseUrl: string;
  private readonly runtimeOptions: OllamaRuntimeOptions;

  constructor(baseUrl = defaultOllamaUrl, runtimeOptions = readOllamaRuntimeOptions()) {
    this.baseUrl = normalizeOllamaBaseUrl(baseUrl);
    this.runtimeOptions = runtimeOptions;
  }

  async chat(options: ModelChatOptions): Promise<ModelChatResult> {
    const response = await this.fetchOllama("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: options.model,
        messages: options.messages,
        stream: false,
        keep_alive: this.runtimeOptions.keepAlive,
        options: {
          num_ctx: this.runtimeOptions.numCtx,
          num_predict: this.runtimeOptions.numPredict,
          temperature: this.runtimeOptions.temperature
        },
        format: options.formatJson ? "json" : undefined
      }),
      signal: options.signal
    });

    const payload = (await readJsonSafely(response)) as OllamaChatResponse;
    if (!response.ok) {
      const reason = payload.error ? ` ${payload.error}` : "";
      throw new Error(`Ollama chat failed for model "${options.model}" at ${this.baseUrl}: HTTP ${response.status}.${reason}`);
    }

    if (payload.error) {
      throw new Error(payload.error);
    }

    return {
      content: payload.message?.content?.trim() ?? "",
      telemetry: toTelemetry(payload, options.model)
    };
  }

  async listModels(): Promise<string[]> {
    const response = await this.fetchOllama("/api/tags");
    if (!response.ok) {
      throw new Error(`Ollama tags failed with HTTP ${response.status}.`);
    }

    const payload = (await response.json()) as OllamaTagsResponse;
    return payload.models?.map((model) => model.name).sort() ?? [];
  }

  private async fetchOllama(path: string, init?: RequestInit): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl}${path}`, init);
    } catch (error) {
      throw new Error(formatOllamaConnectionError(this.baseUrl, error));
    }
  }
}

async function readJsonSafely(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

export function resolveOllamaBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return normalizeOllamaBaseUrl(env.PATCHPILOT_OLLAMA_URL ?? env.OLLAMA_HOST ?? defaultOllamaUrl);
}

export function normalizeOllamaBaseUrl(value: string | undefined): string {
  const trimmedValue = value?.trim() ?? "";
  const normalizedAlias = trimmedValue.toLowerCase();
  if (!trimmedValue || normalizedAlias === "local" || normalizedAlias === "localhost") {
    return defaultOllamaUrl;
  }

  const rawUrl = /^https?:\/\//i.test(trimmedValue) ? trimmedValue : `http://${trimmedValue}`;
  const parsedUrl = new URL(rawUrl);

  if (parsedUrl.hostname === "0.0.0.0" || parsedUrl.hostname === "[::]" || parsedUrl.hostname === "::") {
    parsedUrl.hostname = "127.0.0.1";
  }

  if (!parsedUrl.port && parsedUrl.protocol === "http:") {
    parsedUrl.port = String(defaultOllamaPort);
  }

  if (parsedUrl.pathname === "/api") {
    parsedUrl.pathname = "";
  }

  return parsedUrl.toString().replace(/\/$/, "");
}

export function readOllamaRuntimeOptions(env: NodeJS.ProcessEnv = process.env): OllamaRuntimeOptions {
  return {
    keepAlive: env.PATCHPILOT_KEEP_ALIVE?.trim() || "15m",
    numCtx: readPositiveInteger(env.PATCHPILOT_NUM_CTX, 8192),
    numPredict: readPositiveInteger(env.PATCHPILOT_NUM_PREDICT, 1024),
    temperature: readTemperature(env.PATCHPILOT_TEMPERATURE, 0.1)
  };
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsedValue = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : fallback;
}

function readTemperature(value: string | undefined, fallback: number): number {
  const parsedValue = Number.parseFloat(value ?? "");
  return Number.isFinite(parsedValue) && parsedValue >= 0 ? parsedValue : fallback;
}

function formatOllamaConnectionError(baseUrl: string, error: unknown): string {
  const suffix = error instanceof Error ? ` ${error.message}` : "";
  return `Cannot reach Ollama at ${baseUrl}. Start Ollama, or run "ollama serve", then try /doctor.${suffix}`;
}

function toTelemetry(payload: OllamaChatResponse, model: string): ModelTelemetry {
  const promptTokens = payload.prompt_eval_count ?? 0;
  const responseTokens = payload.eval_count ?? 0;
  const responseDurationMs = nanosToMillis(payload.eval_duration ?? 0);

  return attachTokenCost(
    {
      promptTokens,
      cachedPromptTokens: 0,
      responseTokens,
      totalTokens: promptTokens + responseTokens,
      evalTokensPerSecond:
        responseTokens > 0 && responseDurationMs > 0 ? responseTokens / (responseDurationMs / 1000) : null,
      promptDurationMs: nanosToMillis(payload.prompt_eval_duration ?? 0),
      responseDurationMs,
      totalDurationMs: nanosToMillis(payload.total_duration ?? 0),
      tokenSource: "provider"
    },
    "ollama",
    model
  );
}

function nanosToMillis(value: number): number {
  return Math.round(value / 1_000_000);
}
