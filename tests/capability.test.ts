import { afterEach, describe, expect, it, vi } from "vitest";
import { clearCapabilityCache, probeModelCapabilities, setModelCapabilities } from "../src/core/capability.js";
import type { ModelChatOptions, ModelChatResult, ModelClient } from "../src/core/types.js";

afterEach(() => {
  clearCapabilityCache();
  vi.restoreAllMocks();
});

function telemetry(): ModelChatResult["telemetry"] {
  return {
    promptTokens: 1,
    cachedPromptTokens: 0,
    cacheWriteTokens: 0,
    responseTokens: 1,
    totalTokens: 2,
    evalTokensPerSecond: null,
    timeToFirstTokenMs: null,
    promptDurationMs: 0,
    responseDurationMs: 0,
    totalDurationMs: 0,
    estimatedCostUsd: 0,
    tokenSource: "provider",
    costSource: "local"
  };
}

function stubClient(reply: Partial<ModelChatResult> | (() => never)): ModelClient & { calls: ModelChatOptions[] } {
  const calls: ModelChatOptions[] = [];
  return {
    calls,
    async chat(options: ModelChatOptions): Promise<ModelChatResult> {
      calls.push(options);
      if (typeof reply === "function") {
        reply();
      }
      return { content: "", telemetry: telemetry(), ...reply };
    },
    async listModels(): Promise<string[]> {
      return [];
    }
  };
}

describe("model capability probe", () => {
  it("confirms native tool calling when the model emits a call", async () => {
    const client = stubClient({ toolCalls: [{ name: "read", arguments: { path: "README.md" } }] });
    const result = await probeModelCapabilities({ client, provider: "ollama", model: "qwen3:8b" });

    expect(result.nativeToolCalls).toBe(true);
    expect(result.detail).toContain("read");
  });

  it("advertises exactly one tool, so any capable model must use it", async () => {
    const client = stubClient({ toolCalls: [{ name: "read", arguments: {} }] });
    await probeModelCapabilities({ client, provider: "ollama", model: "qwen3:8b" });

    expect(client.calls[0]?.tools).toHaveLength(1);
    expect(client.calls[0]?.tools?.[0]?.function.name).toBe("read");
  });

  it("reports prose-instead-of-call as unsupported", async () => {
    const client = stubClient({ content: "I would read README.md for you." });
    const result = await probeModelCapabilities({ client, provider: "ollama", model: "qwen2.5-coder:7b" });

    expect(result.nativeToolCalls).toBe(false);
    expect(result.detail).toContain("prose");
  });

  it("rejects a nameless tool call rather than trusting it", async () => {
    const client = stubClient({ toolCalls: [{ name: "", arguments: {} }] });
    const result = await probeModelCapabilities({ client, provider: "ollama", model: "broken" });

    expect(result.nativeToolCalls).toBe(false);
    expect(result.detail).toContain("no name");
  });

  it("probes once per model and shares the result", async () => {
    const client = stubClient({ toolCalls: [{ name: "read", arguments: {} }] });

    const [first, second] = await Promise.all([
      probeModelCapabilities({ client, provider: "ollama", model: "qwen3:8b" }),
      probeModelCapabilities({ client, provider: "ollama", model: "qwen3:8b" })
    ]);

    expect(client.calls).toHaveLength(1);
    expect(first).toEqual(second);
  });

  it("keeps results separate per model and per provider", async () => {
    const client = stubClient({ toolCalls: [{ name: "read", arguments: {} }] });

    await probeModelCapabilities({ client, provider: "ollama", model: "a" });
    await probeModelCapabilities({ client, provider: "ollama", model: "b" });
    await probeModelCapabilities({ client, provider: "local-openai", model: "a" });

    expect(client.calls).toHaveLength(3);
  });

  it("falls back to unsupported on a connection failure without caching it", async () => {
    const client = stubClient(() => {
      throw new Error("ECONNREFUSED");
    });

    const first = await probeModelCapabilities({ client, provider: "ollama", model: "qwen3:8b" });
    expect(first.nativeToolCalls).toBe(false);
    expect(first.detail).toContain("probe failed");

    // A failed probe says nothing about the model, so the next call retries.
    await probeModelCapabilities({ client, provider: "ollama", model: "qwen3:8b" });
    expect(client.calls).toHaveLength(2);
  });

  it("refuses to trust an answer the server served from a different model", async () => {
    const client = stubClient({
      toolCalls: [{ name: "read", arguments: {} }],
      warning: 'Requested "embed-model" but the server answered with "chat-model".'
    });

    const result = await probeModelCapabilities({ client, provider: "local-openai", model: "embed-model" });

    expect(result.nativeToolCalls).toBe(false);
    expect(result.detail).toContain("chat-model");
  });

  it("honours a pre-seeded override without asking the model", async () => {
    const client = stubClient({ content: "prose" });
    setModelCapabilities("ollama", "forced", { nativeToolCalls: true, detail: "set by user" });

    const result = await probeModelCapabilities({ client, provider: "ollama", model: "forced" });

    expect(result.nativeToolCalls).toBe(true);
    expect(client.calls).toHaveLength(0);
  });

  it("clears a single model without discarding the rest", async () => {
    const client = stubClient({ toolCalls: [{ name: "read", arguments: {} }] });
    await probeModelCapabilities({ client, provider: "ollama", model: "a" });
    await probeModelCapabilities({ client, provider: "ollama", model: "b" });

    clearCapabilityCache("ollama", "a");
    await probeModelCapabilities({ client, provider: "ollama", model: "a" });
    await probeModelCapabilities({ client, provider: "ollama", model: "b" });

    expect(client.calls).toHaveLength(3);
  });
});
