import type { ModelProvider } from "./types.js";

/**
 * The local inference runtimes PatchPilot knows how to reach.
 *
 * All of them except Ollama speak the same OpenAI-compatible surface, so they
 * share one client. What actually differs between them is the port, the name a
 * user would recognise, and how you fix it when it is not running — which is
 * exactly what belongs in a registry rather than in per-vendor client code.
 */

export type LocalRuntimeId = "ollama" | "lmstudio" | "mlx" | "llamacpp" | "vllm";

export type LocalRuntime = {
  id: LocalRuntimeId;
  label: string;
  provider: ModelProvider;
  defaultPort: number;
  defaultBaseUrl: string;
  /** Shown when the runtime is not reachable. */
  startHint: string;
  /** Apple-Silicon only, worth saying out loud before someone tries it. */
  appleSiliconOnly?: boolean;
};

export const localRuntimes: Record<LocalRuntimeId, LocalRuntime> = {
  ollama: {
    id: "ollama",
    label: "Ollama",
    provider: "ollama",
    defaultPort: 11434,
    defaultBaseUrl: "http://127.0.0.1:11434",
    startHint: "Start the Ollama app, or run: ollama serve"
  },
  lmstudio: {
    id: "lmstudio",
    label: "LM Studio",
    provider: "local-openai",
    defaultPort: 1234,
    defaultBaseUrl: "http://127.0.0.1:1234/v1",
    startHint: "In LM Studio (or its Bionic app), enable the local server under Settings › Local Model API."
  },
  mlx: {
    id: "mlx",
    label: "MLX",
    provider: "local-openai",
    defaultPort: 8080,
    defaultBaseUrl: "http://127.0.0.1:8080/v1",
    startHint: "Run: mlx_lm.server --model mlx-community/<model> --port 8080",
    appleSiliconOnly: true
  },
  llamacpp: {
    id: "llamacpp",
    label: "llama.cpp",
    provider: "local-openai",
    defaultPort: 8080,
    defaultBaseUrl: "http://127.0.0.1:8080/v1",
    startHint: "Run: llama-server -m <model.gguf> --port 8080"
  },
  vllm: {
    id: "vllm",
    label: "vLLM",
    provider: "local-openai",
    defaultPort: 8000,
    defaultBaseUrl: "http://127.0.0.1:8000/v1",
    startHint: "Run: vllm serve <model> --port 8000"
  }
};

export const localRuntimeOrder: LocalRuntimeId[] = ["ollama", "lmstudio", "mlx", "llamacpp", "vllm"];

/**
 * MLX and llama.cpp both default to 8080, so a port alone cannot identify a
 * runtime. Discovery distinguishes them by what the server actually reports.
 */
export function runtimesOnPort(port: number): LocalRuntime[] {
  return localRuntimeOrder.map((id) => localRuntimes[id]).filter((runtime) => runtime.defaultPort === port);
}

export function resolveRuntimeAlias(value: string): LocalRuntime | null {
  const normalized = value.trim().toLowerCase().replace(/[\s_.-]+/g, "");
  const aliases: Record<string, LocalRuntimeId> = {
    ollama: "ollama",
    lmstudio: "lmstudio",
    lms: "lmstudio",
    bionic: "lmstudio",
    mlx: "mlx",
    mlxlm: "mlx",
    applemlx: "mlx",
    llamacpp: "llamacpp",
    llama: "llamacpp",
    llamaserver: "llamacpp",
    ggml: "llamacpp",
    vllm: "vllm"
  };

  const id = aliases[normalized];
  return id ? localRuntimes[id] : null;
}

/** True on the only platform where MLX can run at all. */
export function supportsMlx(platform: NodeJS.Platform = process.platform, arch: string = process.arch): boolean {
  return platform === "darwin" && arch === "arm64";
}
