import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiClient, readGeminiApiKey, readGeminiRuntimeOptions } from "../src/core/gemini.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GeminiClient", () => {
  it("sends generateContent requests with JSON response mode and telemetry", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(1_500);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: "{\"action\":\"final\",\"message\":\"ok\"}"
                  }
                ]
              }
            }
          ],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 5,
            totalTokenCount: 15
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

    const client = new GeminiClient("test-key", "https://generativelanguage.googleapis.com/v1beta", {
      maxOutputTokens: 512,
      temperature: 0.2
    });
    const result = await client.chat({
      model: "gemini-2.5-flash",
      formatJson: true,
      messages: [
        {
          role: "system",
          content: "Return JSON."
        },
        {
          role: "user",
          content: "hello"
        }
      ]
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=test-key",
      expect.objectContaining({
        method: "POST"
      })
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      systemInstruction: {
        parts: [
          {
            text: "Return JSON."
          }
        ]
      },
      generationConfig: {
        maxOutputTokens: 512,
        temperature: 0.2,
        responseMimeType: "application/json"
      }
    });
    expect(result.content).toBe("{\"action\":\"final\",\"message\":\"ok\"}");
    expect(result.telemetry).toEqual({
      promptTokens: 10,
      cachedPromptTokens: 0,
      responseTokens: 5,
      totalTokens: 15,
      evalTokensPerSecond: 10,
      promptDurationMs: 0,
      responseDurationMs: 500,
      totalDurationMs: 500,
      estimatedCostUsd: null,
      tokenSource: "provider",
      costSource: "unknown"
    });
  });

  it("lists only generateContent-capable models", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          models: [
            {
              name: "models/gemini-2.5-flash",
              supportedGenerationMethods: ["generateContent"]
            },
            {
              name: "models/text-embedding-004",
              supportedGenerationMethods: ["embedContent"]
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

    await expect(new GeminiClient("test-key").listModels()).resolves.toEqual(["gemini-2.5-flash"]);
  });

  it("reads Gemini API key aliases and runtime tuning", () => {
    expect(readGeminiApiKey({ GEMINI_API_KEY: "gemini-key" })).toBe("gemini-key");
    expect(readGeminiApiKey({ GOOGLE_API_KEY: "google-key" })).toBe("google-key");
    expect(readGeminiApiKey({ GEMINI_API_KEY: "gemini-key", GOOGLE_API_KEY: "google-key" })).toBe("google-key");
    expect(
      readGeminiRuntimeOptions({
        PATCHPILOT_NUM_PREDICT: "256",
        PATCHPILOT_TEMPERATURE: "0"
      })
    ).toEqual({
      maxOutputTokens: 256,
      temperature: 0
    });
  });

  it("fails clearly without an API key", async () => {
    const client = new GeminiClient("");
    await expect(
      client.chat({
        model: "gemini-2.5-flash",
        messages: [
          {
            role: "user",
            content: "hello"
          }
        ]
      })
    ).rejects.toThrow("Gemini API key missing");
  });
});
