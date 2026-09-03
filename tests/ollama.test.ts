import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OllamaClient,
  normalizeOllamaBaseUrl,
  readOllamaRuntimeOptions,
  resolveOllamaBaseUrl
} from "../src/core/ollama.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OllamaClient streaming", () => {
  it("streams deltas, separates thinking, and reports telemetry from the final chunk", async () => {
    const chunks = [
      { message: { thinking: "let me look" }, done: false },
      { message: { content: "hel" }, done: false },
      { message: { content: "lo" }, done: false },
      {
        message: { content: "" },
        done: true,
        prompt_eval_count: 5,
        eval_count: 2,
        prompt_eval_duration: 100_000_000,
        eval_duration: 200_000_000,
        total_duration: 300_000_000
      }
    ];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(chunks.map((chunk) => JSON.stringify(chunk)).join("\n"), { status: 200 })
    );

    const content: string[] = [];
    const thinking: string[] = [];
    const result = await new OllamaClient().chat({
      model: "qwen3:8b",
      messages: [{ role: "user", content: "hi" }],
      onDelta: (delta) => {
        if (delta.content) content.push(delta.content);
        if (delta.thinking) thinking.push(delta.thinking);
      }
    });

    expect(content).toEqual(["hel", "lo"]);
    expect(thinking).toEqual(["let me look"]);
    expect(result.content).toBe("hello");
    expect(result.telemetry.promptTokens).toBe(5);
    expect(result.telemetry.timeToFirstTokenMs).not.toBeNull();
  });

  it("requests a stream only when a delta handler is supplied", async () => {
    // A fresh Response per call: a body can only be consumed once.
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(JSON.stringify({ message: { content: "ok" }, done: true }), { status: 200 }));

    await new OllamaClient().chat({ model: "m", messages: [{ role: "user", content: "hi" }] });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).stream).toBe(false);

    await new OllamaClient().chat({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      onDelta: () => undefined
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).stream).toBe(true);
  });

  it("surfaces a mid-stream error instead of returning partial content", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        [JSON.stringify({ message: { content: "par" } }), JSON.stringify({ error: "model crashed" })].join("\n"),
        { status: 200 }
      )
    );

    await expect(
      new OllamaClient().chat({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        onDelta: () => undefined
      })
    ).rejects.toThrow("model crashed");
  });

  it("does not let a throwing delta handler abort the call", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: { content: "ok" }, done: true }), { status: 200 })
    );

    const result = await new OllamaClient().chat({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      onDelta: () => {
        throw new Error("renderer blew up");
      }
    });

    expect(result.content).toBe("ok");
  });
});

describe("OllamaClient", () => {
  it("returns content with token telemetry", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          message: {
            content: "{\"action\":\"final\",\"message\":\"ok\"}"
          },
          prompt_eval_count: 12,
          eval_count: 8,
          prompt_eval_duration: 200_000_000,
          eval_duration: 400_000_000,
          total_duration: 700_000_000
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        }
      )
    );

    const client = new OllamaClient();
    const result = await client.chat({
      model: "qwen2.5-coder:7b",
      messages: [
        {
          role: "user",
          content: "hello"
        }
      ]
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/chat",
      expect.objectContaining({
        method: "POST"
      })
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      keep_alive: "15m",
      options: {
        num_ctx: 8192,
        num_predict: 8192,
        temperature: 0.1
      }
    });
    expect(result.content).toBe("{\"action\":\"final\",\"message\":\"ok\"}");
    expect(result.telemetry).toEqual({
      promptTokens: 12,
      cachedPromptTokens: 0,
      cacheWriteTokens: 0,
      responseTokens: 8,
      totalTokens: 20,
      evalTokensPerSecond: 20,
      promptDurationMs: 200,
      timeToFirstTokenMs: null,
      responseDurationMs: 400,
      totalDurationMs: 700,
      estimatedCostUsd: 0,
      tokenSource: "provider",
      costSource: "local"
    });
  });

  it("uses explicit runtime options for memory-constrained Macs", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          message: {
            content: "ok"
          }
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        }
      )
    );

    const client = new OllamaClient("local", {
      keepAlive: "5m",
      numCtx: 4096,
      numPredict: 512,
      temperature: 0.2
    });

    await client.chat({
      model: "qwen2.5-coder:7b",
      messages: [
        {
          role: "user",
          content: "hello"
        }
      ]
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/chat",
      expect.objectContaining({
        body: expect.stringContaining("\"num_ctx\":4096")
      })
    );
  });

  it("rejects empty chat responses with a clear provider error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          message: {
            content: "   "
          }
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        }
      )
    );

    await expect(
      new OllamaClient().chat({
        model: "qwen2.5-coder:7b",
        messages: [
          {
            role: "user",
            content: "hello"
          }
        ]
      })
    ).rejects.toThrow('Ollama returned an empty response for model "qwen2.5-coder:7b"');
  });

  it("surfaces truncated responses before protocol parsing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          done_reason: "length",
          message: {
            content: "{\"action\":\"tools\""
          }
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        }
      )
    );

    await expect(
      new OllamaClient().chat({
        model: "qwen2.5-coder:7b",
        messages: [
          {
            role: "user",
            content: "hello"
          }
        ]
      })
    ).rejects.toThrow("truncated by num_predict");
  });

  it("lists running models from the Ollama ps endpoint", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          models: [
            {
              name: "qwen2.5-coder:7b",
              size_vram: 4_294_967_296,
              details: {
                context_length: 8192
              }
            },
            {
              model: "deepseek-coder:6.7b"
            }
          ]
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        }
      )
    );

    const client = new OllamaClient("192.168.1.50");
    await expect(client.listRunningModels()).resolves.toEqual([
      {
        name: "deepseek-coder:6.7b",
        sizeBytes: null,
        sizeVramBytes: null,
        expiresAt: null,
        contextLength: null
      },
      {
        name: "qwen2.5-coder:7b",
        sizeBytes: null,
        sizeVramBytes: 4_294_967_296,
        expiresAt: null,
        contextLength: 8192
      }
    ]);
  });

  it("unloads a model with keep_alive 0", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      })
    );

    const client = new OllamaClient("local");
    await client.unloadModel("qwen2.5-coder:7b");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/generate",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          model: "qwen2.5-coder:7b",
          keep_alive: 0
        })
      })
    );
  });

  it("includes the model name when Ollama rejects a chat request", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "model not found"
        }),
        {
          status: 404,
          headers: {
            "Content-Type": "application/json"
          }
        }
      )
    );

    const client = new OllamaClient();
    await expect(
      client.chat({
        model: "missing:model",
        messages: [
          {
            role: "user",
            content: "hello"
          }
        ]
      })
    ).rejects.toThrow('Ollama chat failed for model "missing:model"');
  });
});

describe("Ollama URL config", () => {
  it("defaults to local Ollama for macOS and other local clients", () => {
    expect(resolveOllamaBaseUrl({})).toBe("http://127.0.0.1:11434");
  });

  it("accepts Ollama host environment variables", () => {
    expect(resolveOllamaBaseUrl({ OLLAMA_HOST: "192.168.1.50:11434" })).toBe("http://192.168.1.50:11434");
    expect(resolveOllamaBaseUrl({ PATCHPILOT_OLLAMA_URL: "http://10.0.0.2:11434" })).toBe("http://10.0.0.2:11434");
  });

  it("normalizes bind addresses and accidental api suffixes for client use", () => {
    expect(normalizeOllamaBaseUrl("0.0.0.0:11434")).toBe("http://127.0.0.1:11434");
    expect(normalizeOllamaBaseUrl("http://localhost:11434/api")).toBe("http://localhost:11434");
    expect(normalizeOllamaBaseUrl("192.168.1.50")).toBe("http://192.168.1.50:11434");
  });

  it("reads local runtime tuning from environment", () => {
    expect(
      readOllamaRuntimeOptions({
        PATCHPILOT_KEEP_ALIVE: "30m",
        PATCHPILOT_NUM_CTX: "4096",
        PATCHPILOT_NUM_PREDICT: "768",
        PATCHPILOT_TEMPERATURE: "0"
      })
    ).toEqual({
      keepAlive: "30m",
      numCtx: 4096,
      numPredict: 768,
      temperature: 0
    });
  });
});
