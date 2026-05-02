import type { ChatMessage, ModelChatOptions, ModelChatResult, ModelTelemetry } from "./types.js";
import { attachTokenCost } from "./tokenAccounting.js";

export const defaultGeminiModel = "gemini-2.5-flash";
export const defaultGeminiBaseUrl = "https://generativelanguage.googleapis.com/v1beta";

type GeminiContent = {
  role?: "user" | "model";
  parts: Array<{
    text: string;
  }>;
};

type GeminiGenerateContentResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
    finishReason?: string;
  }>;
  promptFeedback?: {
    blockReason?: string;
  };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
};

type GeminiModelsResponse = {
  models?: Array<{
    name: string;
    supportedGenerationMethods?: string[];
  }>;
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
};

type GeminiRuntimeOptions = {
  maxOutputTokens: number;
  temperature: number;
};

export class GeminiClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly runtimeOptions: GeminiRuntimeOptions;

  constructor(
    apiKey = readGeminiApiKey(),
    baseUrl = process.env.PATCHPILOT_GEMINI_BASE_URL ?? defaultGeminiBaseUrl,
    runtimeOptions = readGeminiRuntimeOptions()
  ) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.runtimeOptions = runtimeOptions;
  }

  async chat(options: ModelChatOptions): Promise<ModelChatResult> {
    this.assertConfigured();
    const startedAt = Date.now();
    const response = await this.fetchGemini(`${modelPath(options.model)}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(toGenerateContentRequest(options.model, options.messages, options.formatJson, this.runtimeOptions, options.reasoningEffort)),
      signal: options.signal
    });
    const durationMs = Date.now() - startedAt;
    const payload = (await readJsonSafely(response)) as GeminiGenerateContentResponse;

    if (!response.ok || payload.error) {
      const reason = payload.error?.message ? ` ${payload.error.message}` : "";
      throw new Error(`Gemini chat failed for model "${options.model}": HTTP ${response.status}.${reason}`);
    }

    const content = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim() ?? "";
    if (!content) {
      const blockReason = payload.promptFeedback?.blockReason;
      const finishReason = payload.candidates?.[0]?.finishReason;
      const reason = blockReason ? ` Prompt blocked: ${blockReason}.` : finishReason ? ` Finish reason: ${finishReason}.` : "";
      throw new Error(`Gemini returned an empty response.${reason}`);
    }

    return {
      content,
      telemetry: toTelemetry(payload, durationMs, options.model)
    };
  }

  async listModels(): Promise<string[]> {
    this.assertConfigured();
    const response = await this.fetchGemini("models");
    const payload = (await readJsonSafely(response)) as GeminiModelsResponse;

    if (!response.ok || payload.error) {
      const reason = payload.error?.message ? ` ${payload.error.message}` : "";
      throw new Error(`Gemini models failed with HTTP ${response.status}.${reason}`);
    }

    return (
      payload.models
        ?.filter((model) => model.supportedGenerationMethods?.includes("generateContent"))
        .map((model) => stripModelPrefix(model.name))
        .sort() ?? []
    );
  }

  private async fetchGemini(path: string, init?: RequestInit): Promise<Response> {
    const separator = path.includes("?") ? "&" : "?";
    try {
      return await fetch(`${this.baseUrl}/${path}${separator}key=${encodeURIComponent(this.apiKey)}`, init);
    } catch (error) {
      const suffix = error instanceof Error ? ` ${error.message}` : "";
      throw new Error(`Cannot reach Gemini API at ${this.baseUrl}.${suffix}`);
    }
  }

  private assertConfigured(): void {
    if (!this.apiKey) {
      throw new Error("Gemini API key missing. Set GEMINI_API_KEY in .env or your shell.");
    }
  }
}

export function readGeminiApiKey(env: NodeJS.ProcessEnv = process.env): string {
  return env.GOOGLE_API_KEY?.trim() || env.GEMINI_API_KEY?.trim() || "";
}

export function readGeminiRuntimeOptions(env: NodeJS.ProcessEnv = process.env): GeminiRuntimeOptions {
  return {
    maxOutputTokens: readPositiveInteger(env.PATCHPILOT_NUM_PREDICT, 1024),
    temperature: readTemperature(env.PATCHPILOT_TEMPERATURE, 0.1)
  };
}

function toGenerateContentRequest(
  model: string,
  messages: ChatMessage[],
  formatJson: boolean | undefined,
  runtimeOptions: GeminiRuntimeOptions,
  reasoningEffort: ModelChatOptions["reasoningEffort"]
) {
  const systemText = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n")
    .trim();
  const contents = messages.filter((message) => message.role !== "system").map(toGeminiContent);

  return {
    systemInstruction: systemText
      ? {
          parts: [
            {
              text: systemText
            }
          ]
        }
      : undefined,
    contents,
      generationConfig: {
        maxOutputTokens: runtimeOptions.maxOutputTokens,
        temperature: runtimeOptions.temperature,
        thinkingConfig: buildGeminiThinkingConfig(model, reasoningEffort),
        responseMimeType: formatJson ? "application/json" : undefined
      }
  };
}

function buildGeminiThinkingConfig(model: string, reasoningEffort: ModelChatOptions["reasoningEffort"]): Record<string, unknown> | undefined {
  if (!reasoningEffort) {
    return undefined;
  }

  if (/gemini-2\.5/i.test(model)) {
    return {
      thinkingBudget:
        reasoningEffort === "low"
          ? 512
          : reasoningEffort === "medium"
            ? 2048
            : reasoningEffort === "high"
              ? 8192
              : 12_288
    };
  }

  return {
    thinkingLevel: reasoningEffort === "xhigh" ? "high" : reasoningEffort
  };
}

function toGeminiContent(message: ChatMessage): GeminiContent {
  return {
    role: message.role === "assistant" ? "model" : "user",
    parts: [
      {
        text: message.content
      }
    ]
  };
}

function modelPath(model: string): string {
  const normalizedModel = model.startsWith("models/") ? model : `models/${model}`;
  return normalizedModel.split("/").map(encodeURIComponent).join("/");
}

function stripModelPrefix(model: string): string {
  return model.startsWith("models/") ? model.slice("models/".length) : model;
}

function toTelemetry(payload: GeminiGenerateContentResponse, durationMs: number, model: string): ModelTelemetry {
  const promptTokens = payload.usageMetadata?.promptTokenCount ?? 0;
  const responseTokens = payload.usageMetadata?.candidatesTokenCount ?? 0;
  const cachedPromptTokens = payload.usageMetadata?.cachedContentTokenCount ?? 0;
  const thoughtsTokens = payload.usageMetadata?.thoughtsTokenCount ?? 0;
  const totalTokens = payload.usageMetadata?.totalTokenCount ?? promptTokens + responseTokens;

  return attachTokenCost(
    {
      promptTokens,
      cachedPromptTokens,
      cacheWriteTokens: 0,
      responseTokens: responseTokens + thoughtsTokens,
      totalTokens,
      evalTokensPerSecond: responseTokens > 0 && durationMs > 0 ? responseTokens / (durationMs / 1000) : null,
      promptDurationMs: 0,
      responseDurationMs: durationMs,
      totalDurationMs: durationMs,
      tokenSource: "provider"
    },
    "gemini",
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
