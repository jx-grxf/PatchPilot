import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeModelProvider } from "../src/core/modelClient.js";
import { OpenRouterClient, isOpenRouterFreeModel } from "../src/core/openrouter.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OpenRouterClient", () => {
  it("lists OpenRouter models with auto router first", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "z/model"
            },
            {
              id: "a/model:free"
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

    await expect(new OpenRouterClient("test-key").listModels()).resolves.toEqual(["openrouter/auto", "a/model:free", "z/model"]);
  });

  it("sends OpenAI-compatible chat requests and reads cache telemetry", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(1000).mockReturnValueOnce(1500);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "{\"action\":\"final\",\"message\":\"ok\"}"
                }
              }
            ],
            usage: {
              prompt_tokens: 1000,
              completion_tokens: 50,
              total_tokens: 1050,
              prompt_tokens_details: {
                cached_tokens: 800,
                cache_write_tokens: 0
              }
            }
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json"
            }
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                id: "openrouter/auto",
                pricing: {
                  prompt: "0",
                  completion: "0",
                  input_cache_read: "0",
                  input_cache_write: "0"
                }
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

    const result = await new OpenRouterClient("test-key").chat({
      model: "auto",
      formatJson: true,
      messages: [
        {
          role: "user",
          content: "hello"
        }
      ]
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-key"
        })
      })
    );
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
        model: "openrouter/auto",
        response_format: {
          type: "json_object"
        }
      });
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).not.toHaveProperty("usage");
    expect(result.telemetry).toMatchObject({
      promptTokens: 1000,
      cachedPromptTokens: 800,
      cacheWriteTokens: 0,
      responseTokens: 50,
      totalTokens: 1050,
      tokenSource: "provider"
    });
  });

  it("normalizes provider aliases and free model names", () => {
    expect(normalizeModelProvider("openrouter")).toBe("openrouter");
    expect(normalizeModelProvider("open-router")).toBe("openrouter");
    expect(isOpenRouterFreeModel("qwen/qwen3:free")).toBe(true);
    expect(isOpenRouterFreeModel("openrouter/auto")).toBe(false);
  });
});
