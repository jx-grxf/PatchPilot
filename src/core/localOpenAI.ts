import type { ModelChatOptions, ModelChatResult, ModelDescriptor, ModelStreamDelta, ModelTelemetry } from "./types.js";
import { fetchWithTimeout } from "./http.js";
import { readServerSentJson, StreamTimer } from "./stream.js";
import { attachTokenCost } from "./tokenAccounting.js";

/**
 * Generic OpenAI-compatible client for local inference servers.
 *
 * One client covers every local runtime that speaks `/v1/chat/completions`:
 * LM Studio (including its Bionic app), llama.cpp's server, vLLM, and
 * anything else exposing the same surface. There is deliberately no
 * per-vendor file — the differences live in configuration, not code.
 */

export const defaultLocalOpenAIModel = "qwen2.5-coder-7b-instruct";
export const defaultLocalOpenAIUrl = "http://127.0.0.1:1234/v1";
export const defaultLocalOpenAIPort = 1234;

type ChatCompletionResponse = {
  choices?: Array<{
    message?: { content?: string };
    /** Streaming frames carry a delta instead of a full message. */
    delta?: {
      content?: string;
      /** Servers disagree on the field name for reasoning text. */
      reasoning_content?: string;
      reasoning?: string;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  error?: { message?: string } | string;
};

type ModelsResponse = {
  data?: Array<{
    id?: string;
    /** LM Studio's /api/v0 extension — absent on plain OpenAI-compatible servers. */
    state?: string;
    max_context_length?: number;
    loaded_context_length?: number;
  }>;
};

type LocalOpenAIRuntimeOptions = {
  apiKey: string;
  maxTokens: number;
  temperature: number;
};

export class LocalOpenAIClient {
  private readonly baseUrl: string;
  private readonly runtimeOptions: LocalOpenAIRuntimeOptions;

  constructor(baseUrl = defaultLocalOpenAIUrl, runtimeOptions = readLocalOpenAIRuntimeOptions()) {
    this.baseUrl = normalizeLocalOpenAIBaseUrl(baseUrl);
    this.runtimeOptions = runtimeOptions;
  }

  async chat(options: ModelChatOptions): Promise<ModelChatResult> {
    const streaming = Boolean(options.onDelta);
    const timer = new StreamTimer();
    const response = await this.fetchLocal("/chat/completions", {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify({
        model: options.model,
        messages: options.messages,
        stream: streaming,
        // Without this, most servers omit usage entirely from a stream.
        ...(streaming ? { stream_options: { include_usage: true } } : {}),
        max_tokens: this.runtimeOptions.maxTokens,
        temperature: this.runtimeOptions.temperature,
        response_format: options.formatJson ? { type: "json_object" } : undefined
      }),
      signal: options.signal
    });

    if (!response.ok) {
      const errorPayload = (await readJsonSafely(response)) as ChatCompletionResponse;
      throw new Error(
        `Local model server rejected model "${options.model}" at ${this.baseUrl}: HTTP ${response.status}.${formatServerError(errorPayload)}`
      );
    }

    const { payload, content, finishReason } = streaming
      ? await this.consumeStream(response, options, timer)
      : await readBufferedResponse(response);

    const serverError = formatServerError(payload);
    if (serverError) {
      throw new Error(serverError.trim());
    }

    if (isTruncatedFinishReason(finishReason)) {
      throw new Error(
        `Local model response for "${options.model}" was truncated by max_tokens (${this.runtimeOptions.maxTokens}).`
      );
    }
    if (!content.trim()) {
      throw new Error(`Local model server returned an empty response for "${options.model}".`);
    }

    return {
      content: content.trim(),
      telemetry: toTelemetry(payload, options.model, timer.elapsedMs, streaming ? timer.timeToFirstTokenMs : null)
    };
  }

  /**
   * SSE frames carry deltas; usage arrives in a final frame with an empty
   * choices array, so the last payload that reports usage wins.
   */
  private async consumeStream(
    response: Response,
    options: ModelChatOptions,
    timer: StreamTimer
  ): Promise<{ payload: ChatCompletionResponse; content: string; finishReason: string | undefined }> {
    let content = "";
    let finishReason: string | undefined;
    let usagePayload: ChatCompletionResponse = {};

    for await (const frame of readServerSentJson(response, options.signal)) {
      const payload = frame as ChatCompletionResponse;
      if (payload.error) {
        return { payload, content, finishReason };
      }
      if (payload.usage) {
        usagePayload = payload;
      }

      const choice = payload.choices?.[0];
      if (choice?.finish_reason) {
        finishReason = choice.finish_reason;
      }

      const thinking = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning;
      const delta: ModelStreamDelta = {};
      if (choice?.delta?.content) {
        content += choice.delta.content;
        delta.content = choice.delta.content;
      }
      if (thinking) {
        delta.thinking = thinking;
      }

      if (delta.content || delta.thinking) {
        timer.markFirstToken();
        emitDelta(options.onDelta, delta);
      }
    }

    return { payload: usagePayload, content, finishReason };
  }

  async listModels(): Promise<string[]> {
    const payload = await this.fetchModels();
    return (
      payload.data
        ?.map((model) => model.id?.trim() ?? "")
        .filter((id) => id.length > 0)
        .sort() ?? []
    );
  }

  /**
   * LM Studio reports load state and context length on its own `/api/v0`
   * surface; plain OpenAI-compatible servers omit those fields and fall back
   * to a bare id list.
   */
  async listModelDescriptors(): Promise<ModelDescriptor[]> {
    const payload = await this.fetchModels();
    return (
      payload.data
        ?.map((model): ModelDescriptor | null => {
          const id = model.id?.trim() ?? "";
          if (!id) {
            return null;
          }

          const capacity = readNullableFiniteNumber(model.max_context_length);
          return {
            id,
            modelName: id,
            isAvailable: model.state === undefined ? true : model.state !== "not-loaded",
            ...(capacity === null ? {} : { capacity }),
            ...(model.state === undefined ? {} : { description: `state: ${model.state}` })
          };
        })
        .filter((model): model is ModelDescriptor => model !== null)
        .sort((left, right) => left.id.localeCompare(right.id)) ?? []
    );
  }

  private async fetchModels(): Promise<ModelsResponse> {
    const response = await this.fetchLocal("/models", { headers: this.buildHeaders() });
    if (!response.ok) {
      throw new Error(`Local model server listing failed with HTTP ${response.status}.`);
    }

    return (await response.json()) as ModelsResponse;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.runtimeOptions.apiKey) {
      headers.Authorization = `Bearer ${this.runtimeOptions.apiKey}`;
    }

    return headers;
  }

  private async fetchLocal(path: string, init?: RequestInit): Promise<Response> {
    try {
      return await fetchWithTimeout(`${this.baseUrl}${path}`, init, {
        timeoutMs: init?.method === "POST" ? 120_000 : 3000,
        retries: init?.method === "POST" ? 2 : 1,
        label: `Local model server ${path} at ${this.baseUrl}`
      });
    } catch (error) {
      throw new Error(formatLocalConnectionError(this.baseUrl, error));
    }
  }
}

async function readBufferedResponse(
  response: Response
): Promise<{ payload: ChatCompletionResponse; content: string; finishReason: string | undefined }> {
  const payload = (await readJsonSafely(response)) as ChatCompletionResponse;
  const choice = payload.choices?.[0];
  return { payload, content: choice?.message?.content ?? "", finishReason: choice?.finish_reason };
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

export function resolveLocalOpenAIBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return normalizeLocalOpenAIBaseUrl(env.PATCHPILOT_LOCAL_URL ?? defaultLocalOpenAIUrl);
}

/**
 * Accepts the shapes people actually paste: a bare host, a host:port, an
 * origin, or a full `/v1` base. Always returns an origin plus API prefix with
 * no trailing slash.
 */
export function normalizeLocalOpenAIBaseUrl(value: string | undefined): string {
  const trimmedValue = value?.trim() ?? "";
  const normalizedAlias = trimmedValue.toLowerCase();
  if (!trimmedValue || normalizedAlias === "local" || normalizedAlias === "localhost") {
    return defaultLocalOpenAIUrl;
  }

  const rawUrl = /^https?:\/\//i.test(trimmedValue) ? trimmedValue : `http://${trimmedValue}`;
  const parsedUrl = new URL(rawUrl);

  if (parsedUrl.hostname === "0.0.0.0" || parsedUrl.hostname === "[::]" || parsedUrl.hostname === "::") {
    parsedUrl.hostname = "127.0.0.1";
  }

  if (!parsedUrl.port && parsedUrl.protocol === "http:") {
    parsedUrl.port = String(defaultLocalOpenAIPort);
  }

  const trimmedPath = parsedUrl.pathname.replace(/\/+$/, "");
  parsedUrl.pathname = trimmedPath === "" || trimmedPath === "/" ? "/v1" : trimmedPath;
  parsedUrl.search = "";
  parsedUrl.hash = "";

  return parsedUrl.toString().replace(/\/$/, "");
}

export function readLocalOpenAIApiKey(env: NodeJS.ProcessEnv = process.env): string {
  return env.PATCHPILOT_LOCAL_API_KEY?.trim() ?? "";
}

export function readLocalOpenAIRuntimeOptions(env: NodeJS.ProcessEnv = process.env): LocalOpenAIRuntimeOptions {
  return {
    apiKey: readLocalOpenAIApiKey(env),
    maxTokens: readPositiveInteger(env.PATCHPILOT_NUM_PREDICT, 8192),
    temperature: readTemperature(env.PATCHPILOT_TEMPERATURE, 0.1)
  };
}

function isTruncatedFinishReason(value: string | undefined): boolean {
  return typeof value === "string" && /length|max_?tokens/i.test(value);
}

function formatServerError(payload: ChatCompletionResponse): string {
  if (typeof payload.error === "string" && payload.error.trim()) {
    return ` ${payload.error.trim()}`;
  }

  if (payload.error && typeof payload.error === "object" && payload.error.message?.trim()) {
    return ` ${payload.error.message.trim()}`;
  }

  return "";
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsedValue = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : fallback;
}

function readTemperature(value: string | undefined, fallback: number): number {
  const parsedValue = Number.parseFloat(value ?? "");
  return Number.isFinite(parsedValue) && parsedValue >= 0 ? parsedValue : fallback;
}

function readTokensPerSecond(responseTokens: number, elapsedMs: number, timeToFirstTokenMs: number | null): number | null {
  const generationMs = timeToFirstTokenMs === null ? elapsedMs : elapsedMs - timeToFirstTokenMs;
  return responseTokens > 0 && generationMs > 0 ? responseTokens / (generationMs / 1000) : null;
}

function readNullableFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatLocalConnectionError(baseUrl: string, error: unknown): string {
  const suffix = error instanceof Error ? ` ${error.message}` : "";
  return `Cannot reach a local model server at ${baseUrl}. Start LM Studio's local server, llama.cpp, or vLLM, then try /doctor.${suffix}`;
}

/**
 * The OpenAI surface reports no server-side timings, so throughput is measured
 * client-side. That includes queueing and transport, which makes it slightly
 * pessimistic next to Ollama's `eval_duration`.
 */
function toTelemetry(
  payload: ChatCompletionResponse,
  model: string,
  elapsedMs: number,
  timeToFirstTokenMs: number | null
): ModelTelemetry {
  const promptTokens = payload.usage?.prompt_tokens ?? 0;
  const responseTokens = payload.usage?.completion_tokens ?? 0;
  const cachedPromptTokens = payload.usage?.prompt_tokens_details?.cached_tokens ?? 0;

  return attachTokenCost(
    {
      promptTokens,
      cachedPromptTokens,
      cacheWriteTokens: 0,
      responseTokens,
      totalTokens: payload.usage?.total_tokens ?? promptTokens + responseTokens,
      // Measure generation against the post-TTFT window when streaming, so the
      // figure reflects decode speed rather than prompt evaluation.
      evalTokensPerSecond: readTokensPerSecond(responseTokens, elapsedMs, timeToFirstTokenMs),
      timeToFirstTokenMs,
      promptDurationMs: timeToFirstTokenMs ?? 0,
      responseDurationMs: elapsedMs,
      totalDurationMs: elapsedMs,
      tokenSource: payload.usage ? "provider" : "estimated"
    },
    "local-openai",
    model
  );
}
