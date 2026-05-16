import type { ModelChatOptions, ModelChatResult, ModelTelemetry } from "./types.js";
import { fetchWithTimeout } from "./http.js";
import { getNvidiaReasoningEffort } from "./reasoning.js";
import { attachTokenCost } from "./tokenAccounting.js";

export const defaultNvidiaModel = "meta/llama-3.1-70b-instruct";
export const defaultNvidiaBaseUrl = "https://integrate.api.nvidia.com/v1";

type NvidiaModelsResponse = {
  data?: Array<{
    id?: string;
  }>;
  error?: {
    message?: string;
  };
};

type NvidiaChatResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
  };
};

type NvidiaRuntimeOptions = {
  maxTokens: number;
  temperature: number;
};

export class NvidiaClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly runtimeOptions: NvidiaRuntimeOptions;

  constructor(
    apiKey = readNvidiaApiKey(),
    baseUrl = process.env.PATCHPILOT_NVIDIA_BASE_URL ?? defaultNvidiaBaseUrl,
    runtimeOptions = readNvidiaRuntimeOptions()
  ) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.runtimeOptions = runtimeOptions;
  }

  async chat(options: ModelChatOptions): Promise<ModelChatResult> {
    this.assertConfigured();
    const startedAt = Date.now();
    const response = await this.fetchNvidia("/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: options.model,
        messages: options.messages,
        max_tokens: this.runtimeOptions.maxTokens,
        temperature: this.runtimeOptions.temperature,
        reasoning_effort: getNvidiaReasoningEffort(options.model, options.reasoningEffort),
        response_format: options.formatJson ? agentResponseFormat : undefined
      }),
      signal: options.signal
    });
    const durationMs = Date.now() - startedAt;
    const payload = (await readJsonSafely(response)) as NvidiaChatResponse;

    if (!response.ok || payload.error) {
      const reason = payload.error?.message ? ` ${payload.error.message}` : "";
      throw new Error(`NVIDIA chat failed for model "${options.model}": HTTP ${response.status}.${reason}`);
    }

    const content = payload.choices?.[0]?.message?.content?.trim() ?? "";
    if (!content) {
      throw new Error("NVIDIA returned an empty response.");
    }

    return {
      content,
      telemetry: toTelemetry(payload, durationMs, options.model)
    };
  }

  async listModels(): Promise<string[]> {
    this.assertConfigured();
    const response = await this.fetchNvidia("/models");
    const payload = (await readJsonSafely(response)) as NvidiaModelsResponse;
    if (!response.ok || payload.error) {
      const reason = payload.error?.message ? ` ${payload.error.message}` : "";
      throw new Error(`NVIDIA models failed with HTTP ${response.status}.${reason}`);
    }

    const models = payload.data?.map((model) => model.id?.trim()).filter((model): model is string => Boolean(model)).sort() ?? [];
    return models.length > 0 ? models : [defaultNvidiaModel];
  }

  private async fetchNvidia(path: string, init?: RequestInit): Promise<Response> {
    try {
      return await fetchWithTimeout(`${this.baseUrl}${path}`, init, {
        timeoutMs: init?.method === "POST" ? 90_000 : 8000,
        retries: init?.method === "POST" ? 0 : 1,
        label: `NVIDIA ${path}`
      });
    } catch (error) {
      const suffix = error instanceof Error ? ` ${error.message}` : "";
      throw new Error(`Cannot reach NVIDIA API at ${this.baseUrl}.${suffix}`);
    }
  }

  private assertConfigured(): void {
    if (!this.apiKey) {
      throw new Error("NVIDIA API key missing. Set NVIDIA_API_KEY in PatchPilot config, .env, or your shell.");
    }
  }
}

const agentResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "patchpilot_agent_response",
    strict: true,
    schema: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["action", "message", "tool_calls"],
          properties: {
            action: { const: "tools" },
            message: { type: "string" },
            tool_calls: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["name", "arguments"],
                properties: {
                  name: {
                    enum: ["list_files", "read_file", "search_text", "inspect_document", "git_status", "list_scripts", "write_file", "run_shell"]
                  },
                  arguments: {
                    type: "object",
                    additionalProperties: true
                  }
                }
              }
            }
          }
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["action", "message"],
          properties: {
            action: { const: "final" },
            message: { type: "string" }
          }
        }
      ]
    }
  }
} as const;

export function readNvidiaApiKey(env: NodeJS.ProcessEnv = process.env): string {
  return env.NVIDIA_API_KEY?.trim() || env.PATCHPILOT_NVIDIA_API_KEY?.trim() || "";
}

function readNvidiaRuntimeOptions(env: NodeJS.ProcessEnv = process.env): NvidiaRuntimeOptions {
  return {
    maxTokens: readPositiveInteger(env.PATCHPILOT_NUM_PREDICT, 1024),
    temperature: readTemperature(env.PATCHPILOT_TEMPERATURE, 0.1)
  };
}

function toTelemetry(payload: NvidiaChatResponse, durationMs: number, model: string): ModelTelemetry {
  const promptTokens = payload.usage?.prompt_tokens ?? 0;
  const responseTokens = payload.usage?.completion_tokens ?? 0;
  return attachTokenCost(
    {
      promptTokens,
      cachedPromptTokens: 0,
      cacheWriteTokens: 0,
      responseTokens,
      totalTokens: payload.usage?.total_tokens ?? promptTokens + responseTokens,
      evalTokensPerSecond: responseTokens > 0 && durationMs > 0 ? responseTokens / (durationMs / 1000) : null,
      promptDurationMs: 0,
      responseDurationMs: durationMs,
      totalDurationMs: durationMs,
      tokenSource: "provider"
    },
    "nvidia",
    model
  );
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
