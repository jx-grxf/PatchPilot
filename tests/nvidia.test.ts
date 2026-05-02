import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeModelProvider } from "../src/core/modelClient.js";
import { NvidiaClient, readNvidiaApiKey } from "../src/core/nvidia.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("NvidiaClient", () => {
  it("normalizes NVIDIA provider aliases and reads API keys", () => {
    expect(normalizeModelProvider("nvidia")).toBe("nvidia");
    expect(normalizeModelProvider("nim")).toBe("nvidia");
    expect(readNvidiaApiKey({ NVIDIA_API_KEY: " key " } as NodeJS.ProcessEnv)).toBe("key");
    expect(readNvidiaApiKey({ PATCHPILOT_NVIDIA_API_KEY: " patch-key " } as NodeJS.ProcessEnv)).toBe("patch-key");
  });

  it("lists NVIDIA models through the OpenAI-compatible models endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "z/model"
            },
            {
              id: "a/model"
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

    await expect(new NvidiaClient("test-key").listModels()).resolves.toEqual(["a/model", "z/model"]);
    expect(fetchMock).toHaveBeenCalledWith("https://integrate.api.nvidia.com/v1/models", undefined);
  });

  it("sends chat requests and reads provider token telemetry", async () => {
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
            prompt_tokens: 10,
            completion_tokens: 3,
            total_tokens: 13
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

    const result = await new NvidiaClient("test-key").chat({
      model: "a/model",
      formatJson: true,
      messages: [
        {
          role: "user",
          content: "hello"
        }
      ]
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: "a/model",
      response_format: {
        type: "json_object"
      }
    });
    expect(result.telemetry).toMatchObject({
      promptTokens: 10,
      responseTokens: 3,
      totalTokens: 13,
      tokenSource: "provider"
    });
  });
});
