import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LocalOpenAIClient,
  normalizeLocalOpenAIBaseUrl,
  readLocalOpenAIRuntimeOptions,
  resolveLocalOpenAIBaseUrl,
  stripTemplateTokens
} from "../src/core/localOpenAI.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function sse(frames: unknown[]): Response {
  return new Response(`${frames.map((frame) => `data: ${JSON.stringify(frame)}`).join("\n\n")}\n\ndata: [DONE]\n\n`, {
    status: 200
  });
}

describe("normalizeLocalOpenAIBaseUrl", () => {
  it("accepts the shapes people actually paste", () => {
    expect(normalizeLocalOpenAIBaseUrl("localhost")).toBe("http://127.0.0.1:1234/v1");
    expect(normalizeLocalOpenAIBaseUrl("")).toBe("http://127.0.0.1:1234/v1");
    expect(normalizeLocalOpenAIBaseUrl("127.0.0.1:1234")).toBe("http://127.0.0.1:1234/v1");
    expect(normalizeLocalOpenAIBaseUrl("http://127.0.0.1:1234")).toBe("http://127.0.0.1:1234/v1");
    expect(normalizeLocalOpenAIBaseUrl("http://127.0.0.1:1234/v1")).toBe("http://127.0.0.1:1234/v1");
    expect(normalizeLocalOpenAIBaseUrl("http://127.0.0.1:1234/v1/")).toBe("http://127.0.0.1:1234/v1");
  });

  it("rewrites wildcard binds to loopback", () => {
    expect(normalizeLocalOpenAIBaseUrl("http://0.0.0.0:8000/v1")).toBe("http://127.0.0.1:8000/v1");
  });

  it("keeps a non-default port and a custom API prefix", () => {
    expect(normalizeLocalOpenAIBaseUrl("http://192.168.1.5:8080/openai/v1")).toBe("http://192.168.1.5:8080/openai/v1");
  });

  it("drops query strings and fragments", () => {
    expect(normalizeLocalOpenAIBaseUrl("http://127.0.0.1:1234/v1?key=x#frag")).toBe("http://127.0.0.1:1234/v1");
  });
});

describe("LocalOpenAIClient configuration", () => {
  it("reads the endpoint from the environment", () => {
    expect(resolveLocalOpenAIBaseUrl({ PATCHPILOT_LOCAL_URL: "lmstudio.local:1234" })).toBe("http://lmstudio.local:1234/v1");
    expect(resolveLocalOpenAIBaseUrl({})).toBe("http://127.0.0.1:1234/v1");
  });

  it("omits the Authorization header when no key is configured", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));

    await new LocalOpenAIClient(undefined, { apiKey: "", maxTokens: 100, temperature: 0.1 }).listModels();
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty("Authorization");

    await new LocalOpenAIClient(undefined, { apiKey: "secret", maxTokens: 100, temperature: 0.1 }).listModels();
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({ Authorization: "Bearer secret" });
  });

  it("shares the generation budget with the Ollama client's env vars", () => {
    const options = readLocalOpenAIRuntimeOptions({ PATCHPILOT_NUM_PREDICT: "4096", PATCHPILOT_TEMPERATURE: "0.7" });
    expect(options.maxTokens).toBe(4096);
    expect(options.temperature).toBe(0.7);
  });
});

describe("LocalOpenAIClient streaming", () => {
  it("assembles content deltas and reports usage from the final frame", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      sse([
        { choices: [{ delta: { content: "hel" } }] },
        { choices: [{ delta: { content: "lo" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } }
      ])
    );

    const seen: string[] = [];
    const result = await new LocalOpenAIClient().chat({
      model: "gemma-4-12b",
      messages: [{ role: "user", content: "hi" }],
      onDelta: (delta) => {
        if (delta.content) seen.push(delta.content);
      }
    });

    expect(seen).toEqual(["hel", "lo"]);
    expect(result.content).toBe("hello");
    expect(result.telemetry.promptTokens).toBe(9);
    expect(result.telemetry.responseTokens).toBe(2);
    expect(result.telemetry.tokenSource).toBe("provider");
  });

  it("accepts either field name servers use for reasoning text", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      sse([
        { choices: [{ delta: { reasoning_content: "step one" } }] },
        { choices: [{ delta: { reasoning: "step two" } }] },
        { choices: [{ delta: { content: "answer" } }] }
      ])
    );

    const thinking: string[] = [];
    const result = await new LocalOpenAIClient().chat({
      model: "deepseek-r1",
      messages: [{ role: "user", content: "hi" }],
      onDelta: (delta) => {
        if (delta.thinking) thinking.push(delta.thinking);
      }
    });

    expect(thinking).toEqual(["step one", "step two"]);
    // Reasoning must never leak into the answer the agent loop parses.
    expect(result.content).toBe("answer");
  });

  it("asks for usage only when streaming", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => sse([{ choices: [{ delta: { content: "ok" } }] }]));

    await new LocalOpenAIClient().chat({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      onDelta: () => undefined
    });
    const streamed = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(streamed.stream).toBe(true);
    expect(streamed.stream_options).toEqual({ include_usage: true });

    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 })
    );
    await new LocalOpenAIClient().chat({ model: "m", messages: [{ role: "user", content: "hi" }] });
    const buffered = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(buffered.stream).toBe(false);
    expect(buffered.stream_options).toBeUndefined();
  });

  it("reports truncation by max_tokens rather than returning a partial answer", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      sse([{ choices: [{ delta: { content: "half" } }] }, { choices: [{ delta: {}, finish_reason: "length" }] }])
    );

    await expect(
      new LocalOpenAIClient().chat({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        onDelta: () => undefined
      })
    ).rejects.toThrow(/truncated by max_tokens/);
  });

  it("skips malformed frames instead of losing the response", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response('data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: {not json\n\ndata: {"choices":[{"delta":{"content":"b"}}]}\n\ndata: [DONE]\n\n', {
          status: 200
        })
    );

    const result = await new LocalOpenAIClient().chat({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      onDelta: () => undefined
    });

    expect(result.content).toBe("ab");
  });
});

describe("LocalOpenAIClient model substitution", () => {
  it("warns when the server answers with a different model than requested", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ model: "prism-ml/bonsai-27b", choices: [{ message: { content: "hi" } }] }), {
          status: 200
        })
    );

    const result = await new LocalOpenAIClient().chat({
      model: "text-embedding-nomic-embed-text-v1.5",
      messages: [{ role: "user", content: "hi" }]
    });

    expect(result.warning).toContain("prism-ml/bonsai-27b");
    expect(result.warning).toContain("not the model you selected");
  });

  it("stays quiet when the server echoes the requested model", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(JSON.stringify({ model: "Qwen3-8B", choices: [{ message: { content: "hi" } }] }), { status: 200 })
    );

    const result = await new LocalOpenAIClient().chat({
      model: "qwen3-8b",
      messages: [{ role: "user", content: "hi" }]
    });

    expect(result.warning).toBeUndefined();
  });

  it("catches a substitution reported mid-stream", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      sse([{ model: "other-model", choices: [{ delta: { content: "hi" } }] }])
    );

    const result = await new LocalOpenAIClient().chat({
      model: "asked-for",
      messages: [{ role: "user", content: "hi" }],
      onDelta: () => undefined
    });

    expect(result.warning).toContain("other-model");
  });
});

describe("LocalOpenAIClient model discovery", () => {
  it("marks unloaded models and carries the advertised context window", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: "b-model", state: "not-loaded", max_context_length: 8192 },
              { id: "a-model", state: "loaded", max_context_length: 32768 }
            ]
          }),
          { status: 200 }
        )
    );

    const descriptors = await new LocalOpenAIClient().listModelDescriptors();
    expect(descriptors.map((entry) => entry.id)).toEqual(["a-model", "b-model"]);
    expect(descriptors[0]?.capacity).toBe(32768);
    expect(descriptors[1]?.isAvailable).toBe(false);
  });

  it("treats a plain OpenAI server without state fields as available", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(JSON.stringify({ data: [{ id: "qwen" }] }), { status: 200 })
    );

    const descriptors = await new LocalOpenAIClient().listModelDescriptors();
    expect(descriptors[0]).toMatchObject({ id: "qwen", isAvailable: true });
    expect(descriptors[0]?.capacity).toBeUndefined();
  });

  it("explains an unreachable server instead of leaking a fetch error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(new LocalOpenAIClient().listModels()).rejects.toThrow(/Cannot reach a local model server/);
  });
});

describe("chat-template tokens that leak into content", () => {
  it("strips the channel markers gemma and gpt-oss builds pass through", () => {
    expect(stripTemplateTokens("<|channel|>thought\nI see the folders.")).toBe("I see the folders.");
    expect(stripTemplateTokens("<channel|>The answer.")).toBe("The answer.");
    expect(stripTemplateTokens("<|im_start|>assistant\nHello")).toBe("Hello");
  });

  it("leaves ordinary prose and real code untouched", () => {
    expect(stripTemplateTokens("Use a < b and c > d")).toBe("Use a < b and c > d");
    expect(stripTemplateTokens("const x: Array<string> = [];")).toBe("const x: Array<string> = [];");
    expect(stripTemplateTokens("if (a<b) return;")).toBe("if (a<b) return;");
  });

  it("keeps html-looking text that is not a control token", () => {
    expect(stripTemplateTokens("<div>hello</div>")).toBe("<div>hello</div>");
  });
});

describe("control tokens beyond the channel markers", () => {
  it("strips the multimodal markers gemma emits mid-word", () => {
    expect(stripTemplateTokens("Trock<audio|>enverfahren")).toBe("Trockenverfahren");
    expect(stripTemplateTokens("a <|image_soft_token|> b")).toBe("a b");
  });

  it("still leaves generics, comparisons and html alone", () => {
    expect(stripTemplateTokens("Map<string, number>")).toBe("Map<string, number>");
    expect(stripTemplateTokens("if (a<b && c>d) {}")).toBe("if (a<b && c>d) {}");
    expect(stripTemplateTokens("<section><p>hi</p></section>")).toBe("<section><p>hi</p></section>");
  });
});
