import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GeminiWrapperClient,
  geminiWrapperRequiresApiKey,
  readGeminiWrapperApiKey,
  readGeminiWrapperBaseUrl,
  readGeminiWrapperCookiesJson,
  readGeminiWrapperMode,
  readGeminiWrapperPythonCommand
} from "../src/core/geminiWrapper.js";
import { normalizeModelProvider } from "../src/core/modelClient.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GeminiWrapperClient", () => {
  it("normalizes provider aliases and reads only explicit wrapper env values", () => {
    expect(normalizeModelProvider("gemini-wrapper")).toBe("gemini-wrapper");
    expect(normalizeModelProvider("geminiwrapper")).toBe("gemini-wrapper");
    expect(readGeminiWrapperBaseUrl({ PATCHPILOT_GEMINI_WRAPPER_BASE_URL: " http://localhost:8787/v1 " } as NodeJS.ProcessEnv)).toBe("http://localhost:8787/v1");
    expect(readGeminiWrapperApiKey({ PATCHPILOT_GEMINI_WRAPPER_API_KEY: " patch-key " } as NodeJS.ProcessEnv)).toBe("patch-key");
    expect(readGeminiWrapperApiKey({ GEMINI_WRAPPER_API_KEY: " wrapper-key " } as NodeJS.ProcessEnv)).toBe("wrapper-key");
    expect(readGeminiWrapperApiKey({ GEMINI_API_KEY: "official-gemini-key" } as NodeJS.ProcessEnv)).toBe("");
    expect(readGeminiWrapperMode({ PATCHPILOT_GEMINI_WRAPPER_MODE: "python" } as NodeJS.ProcessEnv)).toBe("python");
    expect(readGeminiWrapperMode({ PATCHPILOT_GEMINI_WRAPPER_MODE: "invalid" } as NodeJS.ProcessEnv)).toBe("auto");
    expect(readGeminiWrapperCookiesJson({ PATCHPILOT_GEMINI_WRAPPER_COOKIES_JSON: " /tmp/cookies.json " } as NodeJS.ProcessEnv)).toBe("/tmp/cookies.json");
    expect(readGeminiWrapperPythonCommand({ PATCHPILOT_GEMINI_WRAPPER_PYTHON: "python" } as NodeJS.ProcessEnv)).toBe("python");
    expect(geminiWrapperRequiresApiKey("http://localhost:8787/v1")).toBe(false);
    expect(geminiWrapperRequiresApiKey("https://wrapper.example.com/v1")).toBe(true);
  });

  it("requires explicit bridge auth and does not fall back to browser cookies", async () => {
    const client = new GeminiWrapperClient("", "");
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
    ).rejects.toThrow("PatchPilot will not scan browser cookies");
  });

  it("requires an explicit API key for remote wrapper URLs", async () => {
    const client = new GeminiWrapperClient("https://wrapper.example.com/v1", "", undefined, "http");
    await expect(client.listModels()).rejects.toThrow("remote URLs require an explicit API key");
  });

  it("sends OpenAI-compatible chat requests with optional Authorization", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(1000).mockReturnValueOnce(1500);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
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
            prompt_tokens: 12,
            completion_tokens: 4,
            total_tokens: 16,
            prompt_tokens_details: {
              cached_tokens: 8,
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
    );

    const result = await new GeminiWrapperClient(
      "https://wrapper.example.com/v1",
      "test-key",
      {
        maxTokens: 256,
        temperature: 0.2
      },
      "http"
    ).chat({
      model: "gemini-2.5-flash",
      formatJson: true,
      messages: [
        {
          role: "user",
          content: "hello"
        }
      ]
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://wrapper.example.com/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-key"
        })
      })
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: "gemini-2.5-flash",
      max_tokens: 256,
      temperature: 0.2,
      response_format: {
        type: "json_object"
      }
    });
    expect(result.telemetry).toMatchObject({
      promptTokens: 12,
      cachedPromptTokens: 8,
      cacheWriteTokens: 0,
      responseTokens: 4,
      totalTokens: 16,
      tokenSource: "provider"
    });
  });

  it("lists wrapper models and filters non-chat IDs", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "gemini-2.5-flash"
            },
            {
              id: "text-embedding-004"
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

    await expect(new GeminiWrapperClient("http://localhost:8787/v1", "", undefined, "http").listModels()).resolves.toEqual(["gemini-2.5-flash"]);
  });
});
