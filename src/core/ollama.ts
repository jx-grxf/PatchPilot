import type { ModelChatOptions, ModelChatResult, ModelStreamDelta, ModelTelemetry, RawToolCall } from "./types.js";
import { fetchWithTimeout } from "./http.js";
import { readNewlineDelimitedJson, StreamTimer } from "./stream.js";
import { getOllamaThinkValue } from "./reasoning.js";
import { attachTokenCost } from "./tokenAccounting.js";

export const defaultOllamaModel = "qwen2.5-coder:7b";
export const defaultOllamaUrl = "http://127.0.0.1:11434";
export const defaultOllamaPort = 11434;

type OllamaChatResponse = {
  message?: {
    content?: string;
    thinking?: string;
    tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }>;
  };
  done?: boolean;
  error?: string;
  done_reason?: string;
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

type OllamaPsResponse = {
  models?: Array<{
    name?: string;
    model?: string;
      size?: number;
      size_vram?: number;
      expires_at?: string;
      context_length?: number;
      details?: {
        context_length?: number;
      };
  }>;
};

export type OllamaRunningModel = {
  name: string;
  sizeBytes: number | null;
  sizeVramBytes: number | null;
  expiresAt: string | null;
  contextLength: number | null;
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
    const streaming = Boolean(options.onDelta);
    const timer = new StreamTimer();
    const response = await this.fetchOllama("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: options.model,
        messages: options.messages,
        stream: streaming,
        keep_alive: this.runtimeOptions.keepAlive,
        think: getOllamaThinkValue(options.model, options.thinking),
        options: {
          num_ctx: this.runtimeOptions.numCtx,
          num_predict: this.runtimeOptions.numPredict,
          temperature: this.runtimeOptions.temperature
        },
        // Advertising tools switches Ollama to grammar-constrained decoding
        // against each schema, which is what makes malformed calls impossible
        // rather than merely repairable.
        tools: options.tools,
        // json format and tools are mutually exclusive: asking for both makes
        // the model emit a JSON blob describing a call instead of calling.
        format: options.tools ? undefined : options.formatJson ? "json" : undefined
      }),
      signal: options.signal
    });

    if (!response.ok) {
      const errorPayload = (await readJsonSafely(response)) as OllamaChatResponse;
      const reason = errorPayload.error ? ` ${errorPayload.error}` : "";
      throw new Error(`Ollama chat failed for model "${options.model}" at ${this.baseUrl}: HTTP ${response.status}.${reason}`);
    }

    const { payload, content } = streaming
      ? await this.consumeStream(response, options, timer)
      : await readBufferedResponse(response);

    if (payload.error) {
      throw new Error(payload.error);
    }

    if (isTruncatedDoneReason(payload.done_reason)) {
      throw new Error(`Ollama response for model "${options.model}" was truncated by num_predict (${this.runtimeOptions.numPredict}).`);
    }
    // A tool call with no prose is a complete, valid response.
    if (!content.trim() && readToolCalls(payload).length === 0) {
      throw new Error(`Ollama returned an empty response for model "${options.model}".`);
    }

    const toolCalls = readToolCalls(payload);
    return {
      content: content.trim(),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      telemetry: toTelemetry(payload, options.model, streaming ? timer.timeToFirstTokenMs : null)
    };
  }

  /**
   * Ollama emits one JSON object per chunk and repeats the cumulative counters
   * on the final `done` object, so the last payload carries the telemetry.
   */
  private async consumeStream(
    response: Response,
    options: ModelChatOptions,
    timer: StreamTimer
  ): Promise<{ payload: OllamaChatResponse; content: string }> {
    let content = "";
    let finalPayload: OllamaChatResponse = {};
    const streamedToolCalls: NonNullable<NonNullable<OllamaChatResponse["message"]>["tool_calls"]> = [];

    for await (const chunk of readNewlineDelimitedJson(response, options.signal)) {
      const payload = chunk as OllamaChatResponse;
      if (payload.error) {
        return { payload, content };
      }

      const delta: ModelStreamDelta = {};
      if (payload.message?.content) {
        content += payload.message.content;
        delta.content = payload.message.content;
      }
      if (payload.message?.thinking) {
        delta.thinking = payload.message.thinking;
      }

      if (delta.content || delta.thinking) {
        timer.markFirstToken();
        emitDelta(options.onDelta, delta);
      }

      if (payload.message?.tool_calls?.length) {
        streamedToolCalls.push(...payload.message.tool_calls);
      }

      if (payload.done) {
        finalPayload = payload;
      }
    }

    if (streamedToolCalls.length > 0) {
      finalPayload = { ...finalPayload, message: { ...finalPayload.message, tool_calls: streamedToolCalls } };
    }

    return { payload: finalPayload, content };
  }

  async listModels(): Promise<string[]> {
    const response = await this.fetchOllama("/api/tags");
    if (!response.ok) {
      throw new Error(`Ollama tags failed with HTTP ${response.status}.`);
    }

    const payload = (await response.json()) as OllamaTagsResponse;
    return payload.models?.map((model) => model.name).sort() ?? [];
  }

  async listRunningModels(): Promise<OllamaRunningModel[]> {
    const response = await this.fetchOllama("/api/ps");
    if (!response.ok) {
      throw new Error(`Ollama ps failed with HTTP ${response.status}.`);
    }

    const payload = (await response.json()) as OllamaPsResponse;
    return (
      payload.models
        ?.map((model): OllamaRunningModel | null => {
          const name = model.name?.trim() || model.model?.trim() || "";
          return name
            ? {
                name,
                sizeBytes: readNullableFiniteNumber(model.size),
                sizeVramBytes: readNullableFiniteNumber(model.size_vram),
                expiresAt: typeof model.expires_at === "string" ? model.expires_at : null,
                contextLength: readNullableFiniteNumber(model.context_length ?? model.details?.context_length)
              }
            : null;
        })
        .filter((model): model is OllamaRunningModel => model !== null)
        .sort((left, right) => left.name.localeCompare(right.name)) ?? []
    );
  }

  async unloadModel(model: string): Promise<void> {
    const trimmedModel = model.trim();
    if (!trimmedModel) {
      return;
    }

    const response = await this.fetchOllama("/api/generate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: trimmedModel,
        keep_alive: 0
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama unload failed for model "${trimmedModel}" at ${this.baseUrl}: HTTP ${response.status}.`);
    }
  }

  private async fetchOllama(path: string, init?: RequestInit): Promise<Response> {
    try {
      return await fetchWithTimeout(`${this.baseUrl}${path}`, init, {
        timeoutMs: init?.method === "POST" ? 120_000 : 3000,
        retries: init?.method === "POST" ? 2 : 1,
        label: `Ollama ${path} at ${this.baseUrl}`
      });
    } catch (error) {
      throw new Error(formatOllamaConnectionError(this.baseUrl, error));
    }
  }
}

function readToolCalls(payload: OllamaChatResponse): RawToolCall[] {
  return (payload.message?.tool_calls ?? []).map((call) => ({
    name: call.function?.name,
    arguments: call.function?.arguments
  }));
}

async function readBufferedResponse(response: Response): Promise<{ payload: OllamaChatResponse; content: string }> {
  const payload = (await readJsonSafely(response)) as OllamaChatResponse;
  return { payload, content: payload.message?.content ?? "" };
}

/** A renderer that throws must never take the model call down with it. */
function emitDelta(onDelta: ModelChatOptions["onDelta"], delta: ModelStreamDelta): void {
  try {
    onDelta?.(delta);
  } catch {
    // Rendering is best-effort; the response still matters.
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
    numPredict: readPositiveInteger(env.PATCHPILOT_NUM_PREDICT, 8192),
    temperature: readTemperature(env.PATCHPILOT_TEMPERATURE, 0.1)
  };
}

function isTruncatedDoneReason(value: string | undefined): boolean {
  return typeof value === "string" && /length|max_?tokens|num_predict/i.test(value);
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsedValue = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : fallback;
}

function readTemperature(value: string | undefined, fallback: number): number {
  const parsedValue = Number.parseFloat(value ?? "");
  return Number.isFinite(parsedValue) && parsedValue >= 0 ? parsedValue : fallback;
}

function readNullableFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatOllamaConnectionError(baseUrl: string, error: unknown): string {
  const suffix = error instanceof Error ? ` ${error.message}` : "";
  return `Cannot reach Ollama at ${baseUrl}. Start Ollama, or run "ollama serve", then try /doctor.${suffix}`;
}

function toTelemetry(payload: OllamaChatResponse, model: string, timeToFirstTokenMs: number | null): ModelTelemetry {
  const promptTokens = payload.prompt_eval_count ?? 0;
  const responseTokens = payload.eval_count ?? 0;
  const responseDurationMs = nanosToMillis(payload.eval_duration ?? 0);

  return attachTokenCost(
    {
      promptTokens,
      cachedPromptTokens: 0,
      cacheWriteTokens: 0,
      responseTokens,
      totalTokens: promptTokens + responseTokens,
      evalTokensPerSecond:
        responseTokens > 0 && responseDurationMs > 0 ? responseTokens / (responseDurationMs / 1000) : null,
      timeToFirstTokenMs,
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
