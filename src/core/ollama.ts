import type { ChatMessage } from "./types.js";

type OllamaChatResponse = {
  message?: {
    content?: string;
  };
  error?: string;
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

export class OllamaClient {
  private readonly baseUrl: string;

  constructor(baseUrl = "http://127.0.0.1:11434") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async chat(options: OllamaChatOptions): Promise<string> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: options.model,
        messages: options.messages,
        stream: false,
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

    return payload.message?.content?.trim() ?? "";
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
