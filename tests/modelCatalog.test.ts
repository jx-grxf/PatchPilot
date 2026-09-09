import { describe, expect, it } from "vitest";
import {
  localRuntimes,
  resolveRuntimeAlias,
  runtimesOnPort,
  supportsMlx
} from "../src/core/localRuntimes.js";
import { describeModel, isUsableForChat, rankForAgentUse, type CatalogModel } from "../src/core/modelCatalog.js";
import { normalizeModelProvider } from "../src/core/modelClient.js";

function model(overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id: "qwen3:8b",
    runtime: "ollama",
    runtimeLabel: "Ollama",
    provider: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    loaded: false,
    contextLength: null,
    kind: null,
    sizeBytes: null,
    ...overrides
  };
}

describe("local runtime registry", () => {
  it("knows each runtime's default port", () => {
    expect(localRuntimes.ollama.defaultPort).toBe(11434);
    expect(localRuntimes.lmstudio.defaultPort).toBe(1234);
    expect(localRuntimes.mlx.defaultPort).toBe(8080);
    expect(localRuntimes.vllm.defaultPort).toBe(8000);
  });

  it("routes everything except Ollama through the OpenAI-compatible client", () => {
    expect(localRuntimes.ollama.provider).toBe("ollama");
    for (const id of ["lmstudio", "mlx", "llamacpp", "vllm"] as const) {
      expect(localRuntimes[id].provider).toBe("local-openai");
    }
  });

  it("reports the port collision between MLX and llama.cpp", () => {
    expect(runtimesOnPort(8080).map((runtime) => runtime.id)).toEqual(["mlx", "llamacpp"]);
    expect(runtimesOnPort(1234).map((runtime) => runtime.id)).toEqual(["lmstudio"]);
  });

  it("resolves the names people actually type", () => {
    expect(resolveRuntimeAlias("bionic")?.id).toBe("lmstudio");
    expect(resolveRuntimeAlias("LM Studio")?.id).toBe("lmstudio");
    expect(resolveRuntimeAlias("mlx-lm")?.id).toBe("mlx");
    expect(resolveRuntimeAlias("llama.cpp")?.id).toBe("llamacpp");
    expect(resolveRuntimeAlias("vLLM")?.id).toBe("vllm");
    expect(resolveRuntimeAlias("openai")).toBeNull();
  });

  it("routes every registry alias through the matching provider client", () => {
    for (const alias of ["lms", "applemlx", "llamaserver", "ggml"]) {
      expect(normalizeModelProvider(alias), alias).toBe("local-openai");
    }
    expect(normalizeModelProvider("ollama")).toBe("ollama");
  });

  it("gives every runtime an actionable way to start it", () => {
    for (const runtime of Object.values(localRuntimes)) {
      expect(runtime.startHint.length).toBeGreaterThan(20);
    }
    expect(localRuntimes.mlx.startHint).toContain("mlx_lm.server");
  });

  it("gates MLX to Apple Silicon", () => {
    expect(localRuntimes.mlx.appleSiliconOnly).toBe(true);
    expect(supportsMlx("darwin", "arm64")).toBe(true);
    expect(supportsMlx("darwin", "x64")).toBe(false);
    expect(supportsMlx("linux", "arm64")).toBe(false);
  });
});

describe("chat suitability", () => {
  it("rejects models that cannot chat, by reported type or by name", () => {
    expect(isUsableForChat(model({ kind: "embeddings" }))).toBe(false);
    expect(isUsableForChat(model({ id: "text-embedding-nomic-embed-text-v1.5" }))).toBe(false);
    expect(isUsableForChat(model({ id: "bge-large-en" }))).toBe(false);
    expect(isUsableForChat(model({ id: "whisper-large-v3" }))).toBe(false);
  });

  it("keeps ordinary chat and vision models", () => {
    expect(isUsableForChat(model({ id: "qwen3:8b" }))).toBe(true);
    expect(isUsableForChat(model({ id: "prism-ml/bonsai-27b", kind: "vlm" }))).toBe(true);
  });
});

describe("ranking for agent use", () => {
  it("puts loaded models first, because loading one costs more than the task", () => {
    const ranked = rankForAgentUse([
      model({ id: "cold", loaded: false, contextLength: 262_144 }),
      model({ id: "warm", loaded: true, contextLength: 8192 })
    ]);

    expect(ranked.map((entry) => entry.id)).toEqual(["warm", "cold"]);
  });

  it("prefers a larger context among equally loaded models", () => {
    const ranked = rankForAgentUse([
      model({ id: "small", loaded: true, contextLength: 8192 }),
      model({ id: "large", loaded: true, contextLength: 131_072 })
    ]);

    expect(ranked.map((entry) => entry.id)).toEqual(["large", "small"]);
  });

  it("orders by name when nothing else separates them", () => {
    const ranked = rankForAgentUse([model({ id: "b" }), model({ id: "a" })]);
    expect(ranked.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("does not mutate the input", () => {
    const input = [model({ id: "b" }), model({ id: "a" })];
    rankForAgentUse(input);
    expect(input.map((entry) => entry.id)).toEqual(["b", "a"]);
  });
});

describe("model description", () => {
  it("reads as a single scannable line", () => {
    expect(
      describeModel(model({ runtimeLabel: "LM Studio", loaded: true, contextLength: 41_000, kind: "vlm" }))
    ).toBe("LM Studio · loaded · 41k ctx · vlm");
  });

  it("abbreviates large windows without lying about them", () => {
    expect(describeModel(model({ contextLength: 262_144 }))).toContain("262k ctx");
    expect(describeModel(model({ contextLength: 1_000_000 }))).toContain("1M ctx");
    expect(describeModel(model({ contextLength: 1_500_000 }))).toContain("1.5M ctx");
    expect(describeModel(model({ contextLength: 512 }))).toContain("512 ctx");
  });

  it("stays quiet about anything the runtime did not report", () => {
    expect(describeModel(model({ loaded: null, contextLength: null, kind: null }))).toBe("Ollama");
  });
});
