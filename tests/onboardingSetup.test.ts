import { describe, expect, it } from "vitest";
import type { ModelCatalog } from "../src/core/modelCatalog.js";
import { localRuntimes, type LocalRuntimeId } from "../src/core/localRuntimes.js";
import { installGuide, runtimeChoices } from "../src/tui/onboardingSetup.js";

function catalog(running: Partial<Record<LocalRuntimeId, string[]>>, baseUrls: Partial<Record<LocalRuntimeId, string>> = {}): ModelCatalog {
  const runtimes = (Object.keys(localRuntimes) as LocalRuntimeId[]).map((id) => {
    const runtime = localRuntimes[id];
    const ids = running[id];
    const baseUrl = baseUrls[id] ?? runtime.defaultBaseUrl;
    return {
      runtime,
      reachable: ids !== undefined,
      models: (ids ?? []).map((modelId) => ({
        id: modelId,
        runtime: id,
        runtimeLabel: runtime.label,
        provider: runtime.provider,
        baseUrl,
        loaded: null,
        contextLength: null,
        kind: null,
        sizeBytes: null
      })),
      detail: ""
    };
  });
  return { runtimes, models: runtimes.flatMap((status) => status.models) };
}

describe("runtimeChoices", () => {
  it("leads with the install guide when nothing runs", () => {
    const choices = runtimeChoices(catalog({}), { platform: "linux" });
    expect(choices.map((choice) => choice.kind)).toEqual(["install", "ollama-local", "remote-ollama", "custom-url"]);
    expect(choices[1]?.description).toContain("ollama serve");
  });

  it("offers to open the Ollama app on macOS", () => {
    const choices = runtimeChoices(catalog({}), { platform: "darwin" });
    expect(choices.find((choice) => choice.kind === "ollama-local")?.description).toContain("opens the Ollama app");
  });

  it("puts running runtimes first with their model counts", () => {
    const choices = runtimeChoices(catalog({ ollama: ["qwen3.5:9b"], lmstudio: ["a", "b"] }), { platform: "linux" });
    expect(choices.map((choice) => choice.label)).toEqual(["Ollama", "LM Studio", "Ollama on another machine", "Other server URL", "Install a runtime"]);
    expect(choices[0]?.description).toContain("1 model");
    expect(choices[1]?.description).toContain("2 models");
    expect(choices[1]).toMatchObject({ kind: "openai-local", baseUrl: "http://127.0.0.1:1234/v1" });
  });

  it("says when a running Ollama has no models", () => {
    const choices = runtimeChoices(catalog({ ollama: [] }), { platform: "linux" });
    expect(choices[0]?.description).toContain("no models yet");
  });

  it("merges two runtimes that answer on the same port", () => {
    const choices = runtimeChoices(catalog({ mlx: ["m"], llamacpp: ["m"] }), { platform: "darwin" });
    const shared = choices.filter((choice) => choice.kind === "openai-local");
    expect(shared).toHaveLength(1);
    expect(shared[0]?.label).toBe("MLX / llama.cpp");
  });

  it("offers to start an installed MLX first", () => {
    const choices = runtimeChoices(catalog({}), { platform: "darwin", mlxInstalled: true });
    expect(choices[0]?.kind).toBe("mlx-autostart");
    expect(choices.at(-1)?.kind).toBe("install");
  });

  it("does not offer to start MLX when it already runs", () => {
    const choices = runtimeChoices(catalog({ mlx: ["m"] }), { platform: "darwin", mlxInstalled: true });
    expect(choices.some((choice) => choice.kind === "mlx-autostart")).toBe(false);
  });
});

describe("installGuide", () => {
  it.each([
    ["darwin", "arm64", "brew install ollama"],
    ["linux", "x64", "curl -fsSL https://ollama.com/install.sh | sh"],
    ["win32", "x64", "winget install Ollama.Ollama"]
  ] as const)("gives %s a one-line install", (platform, arch, command) => {
    const guide = installGuide(platform, arch);
    expect(guide.steps[0]?.command).toBe(command);
    expect(guide.steps[1]?.command).toBe("ollama pull qwen3.5:9b");
  });

  it("mentions MLX only on Apple Silicon", () => {
    expect(installGuide("darwin", "arm64").alternatives.some((step) => step.command === "pip install mlx-lm")).toBe(true);
    expect(installGuide("darwin", "x64").alternatives.some((step) => step.command === "pip install mlx-lm")).toBe(false);
  });
});
