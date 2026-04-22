import { afterEach, describe, expect, it, vi } from "vitest";
import { OllamaClient } from "../src/core/ollama.js";

afterEach(() => {
  vi.restoreAllMocks();
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
    expect(result.content).toBe("{\"action\":\"final\",\"message\":\"ok\"}");
    expect(result.telemetry).toEqual({
      promptTokens: 12,
      responseTokens: 8,
      totalTokens: 20,
      evalTokensPerSecond: 20,
      promptDurationMs: 200,
      responseDurationMs: 400,
      totalDurationMs: 700
    });
  });
});
