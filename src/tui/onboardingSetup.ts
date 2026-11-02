import type { ModelCatalog } from "../core/modelCatalog.js";
import { defaultOllamaModel } from "../core/ollama.js";

export type RuntimeChoice =
  | { kind: "ollama-local"; label: string; description: string; running: boolean; modelCount: number }
  | { kind: "openai-local"; label: string; description: string; baseUrl: string; modelCount: number }
  | { kind: "mlx-autostart"; label: string; description: string }
  | { kind: "remote-ollama"; label: string; description: string }
  | { kind: "custom-url"; label: string; description: string }
  | { kind: "install"; label: string; description: string };

function countLabel(count: number): string {
  if (count === 0) {
    return "running, no models yet";
  }
  return `running · ${count} model${count === 1 ? "" : "s"}`;
}

/**
 * Rows for the "where does the model run" step. Runtimes that answered come
 * first, so the common case is a single Enter; a machine with nothing running
 * leads with the install guide instead of an error.
 */
export function runtimeChoices(
  catalog: ModelCatalog,
  options: { platform?: NodeJS.Platform; mlxInstalled?: boolean } = {}
): RuntimeChoice[] {
  const platform = options.platform ?? process.platform;
  const ollama = catalog.runtimes.find((status) => status.runtime.id === "ollama");
  const ollamaRunning = Boolean(ollama?.reachable);

  const openAIByUrl = new Map<string, { labels: string[]; modelCount: number }>();
  for (const status of catalog.runtimes) {
    if (!status.reachable || status.runtime.provider !== "local-openai") {
      continue;
    }
    const baseUrl = status.models[0]?.baseUrl ?? status.runtime.defaultBaseUrl;
    // MLX and llama.cpp share port 8080, so one server can answer for both.
    const entry = openAIByUrl.get(baseUrl) ?? { labels: [], modelCount: status.models.length };
    entry.labels.push(status.runtime.label);
    openAIByUrl.set(baseUrl, entry);
  }
  const mlxRunning = [...openAIByUrl.values()].some((entry) => entry.labels.includes("MLX"));

  const running: RuntimeChoice[] = [];
  if (ollamaRunning) {
    running.push({
      kind: "ollama-local",
      label: "Ollama",
      description: `${countLabel(ollama?.models.length ?? 0)} · this device`,
      running: true,
      modelCount: ollama?.models.length ?? 0
    });
  }
  for (const [baseUrl, entry] of openAIByUrl) {
    running.push({
      kind: "openai-local",
      label: entry.labels.join(" / "),
      description: `${countLabel(entry.modelCount)} · ${baseUrl}`,
      baseUrl,
      modelCount: entry.modelCount
    });
  }

  const idle: RuntimeChoice[] = [];
  if (options.mlxInstalled && !mlxRunning) {
    idle.push({
      kind: "mlx-autostart",
      label: "MLX",
      description: "installed; starts with Qwen3.5 9B (first start downloads 6 GB)"
    });
  }
  if (!ollamaRunning) {
    idle.push({
      kind: "ollama-local",
      label: "Ollama",
      description: platform === "darwin" ? "not running; PatchPilot opens the Ollama app" : "not running; start it with: ollama serve",
      running: false,
      modelCount: 0
    });
  }

  const other: RuntimeChoice[] = [
    { kind: "remote-ollama", label: "Ollama on another machine", description: "LAN or Tailscale; files and shell stay on this device" },
    { kind: "custom-url", label: "Other server URL", description: "llama.cpp, vLLM or any OpenAI-compatible endpoint" }
  ];
  const install: RuntimeChoice = {
    kind: "install",
    label: "Install a runtime",
    description: running.length === 0 ? "nothing is running yet; shows the commands for this system" : "commands for Ollama, LM Studio and MLX"
  };

  return running.length === 0 && idle.every((choice) => choice.kind !== "mlx-autostart")
    ? [install, ...idle, ...other]
    : [...running, ...idle, ...other, install];
}

type InstallStep = { text: string; command?: string };

export type InstallGuide = {
  system: string;
  steps: InstallStep[];
  alternatives: InstallStep[];
};

export function installGuide(platform: NodeJS.Platform = process.platform, arch: string = process.arch): InstallGuide {
  const pull: InstallStep = { text: `Download the default model (about 6.6 GB, runs well with 16 GB of RAM)`, command: `ollama pull ${defaultOllamaModel}` };
  const lmStudio: InstallStep = { text: "LM Studio (lmstudio.ai): load a model and turn on its local server" };

  if (platform === "darwin") {
    return {
      system: arch === "arm64" ? "macOS on Apple Silicon" : "macOS",
      steps: [{ text: "Install Ollama, or download the app from ollama.com/download", command: "brew install ollama" }, pull],
      alternatives: [
        lmStudio,
        ...(arch === "arm64" ? [{ text: "MLX: PatchPilot starts it by itself once it is installed", command: "pip install mlx-lm" }] : [])
      ]
    };
  }

  if (platform === "win32") {
    return {
      system: "Windows",
      steps: [{ text: "Install Ollama, or download it from ollama.com/download", command: "winget install Ollama.Ollama" }, pull],
      alternatives: [lmStudio]
    };
  }

  return {
    system: "Linux",
    steps: [{ text: "Install Ollama", command: "curl -fsSL https://ollama.com/install.sh | sh" }, pull],
    alternatives: [lmStudio, { text: "llama.cpp or vLLM: start the server, then pick Other server URL" }]
  };
}

export const starterPrompts = [
  "summarize this repo and list the riskiest untested paths",
  "add a test for the function you consider most fragile, then run it",
  "explain how a request flows through this codebase"
];

export const starterKeys: Array<{ key: string; text: string }> = [
  { key: "tab", text: "switch between plan (read-only) and build" },
  { key: "/model", text: "change the model" },
  { key: "/help", text: "list every command" },
  { key: "esc", text: "stop a running answer" }
];
