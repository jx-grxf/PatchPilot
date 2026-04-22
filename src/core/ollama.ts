import type { ChatMessage, ModelTelemetry } from "./types.js";

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

export type OllamaChatOptions = {
  model: string;
  messages: ChatMessage[];
  formatJson?: boolean;
  signal?: AbortSignal;
};

export type OllamaChatResult = {
  content: string;
  telemetry: ModelTelemetry;
};

export class OllamaClient {
  private readonly baseUrl: string;

  constructor(baseUrl = "http://127.0.0.1:11434") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async chat(options: OllamaChatOptions): Promise<OllamaChatResult> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: options.model,
        messages: options.messages,
        stream: false,
        keep_alive: "15m",
        options: {
          num_ctx: 8192,
          num_predict: 1024,
          temperature: 0.1
        },
        format: options.formatJson ? "json" : undefined
      }),
      signal: options.signal
    });

    if (!response.ok) {
      throw new Error(`Ollama chat failed with HTTP ${response.status}.`);
    }

    const payload = (await response.json()) as OllamaChatResponse;
    if (payload.error) {
      throw new Error(payload.error);
    }

    return {
      content: payload.message?.content?.trim() ?? "",
      telemetry: toTelemetry(payload)
    };
  }

  async listModels(): Promise<string[]> {
    const response = await fetch(`${this.baseUrl}/api/tags`);
    if (!response.ok) {
      throw new Error(`Ollama tags failed with HTTP ${response.status}.`);
    }

    const payload = (await response.json()) as OllamaTagsResponse;
    return payload.models?.map((model) => model.name).sort() ?? [];
  }
}

function toTelemetry(payload: OllamaChatResponse): ModelTelemetry {
  const promptTokens = payload.prompt_eval_count ?? 0;
  const responseTokens = payload.eval_count ?? 0;
  const responseDurationMs = nanosToMillis(payload.eval_duration ?? 0);

  return {
    promptTokens,
    responseTokens,
    totalTokens: promptTokens + responseTokens,
    evalTokensPerSecond:
      responseTokens > 0 && responseDurationMs > 0 ? responseTokens / (responseDurationMs / 1000) : null,
    promptDurationMs: nanosToMillis(payload.prompt_eval_duration ?? 0),
    responseDurationMs,
    totalDurationMs: nanosToMillis(payload.total_duration ?? 0)
  };
}

function nanosToMillis(value: number): number {
  return Math.round(value / 1_000_000);
}
