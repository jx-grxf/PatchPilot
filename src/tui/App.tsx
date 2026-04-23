import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, useApp, useInput } from "ink";
import { AgentRunner, type AgentRunnerOptions } from "../core/agent.js";
import { defaultCodexModel, hasCodexCliOAuth } from "../core/codex.js";
import { describeComputeTarget } from "../core/compute.js";
import { runDoctor } from "../core/doctor.js";
import { defaultGeminiModel } from "../core/gemini.js";
import { saveDotEnvValues } from "../core/env.js";
import { createModelClient } from "../core/modelClient.js";
import { defaultOllamaModel } from "../core/ollama.js";
import type { AgentEvent, ModelProvider, ModelTelemetry } from "../core/types.js";
import { CommandSuggestions } from "./components/CommandSuggestions.js";
import { Composer, FooterHints } from "./components/Composer.js";
import { Header } from "./components/Header.js";
import { OnboardingPanel, type OnboardingState } from "./components/OnboardingPanel.js";
import { Sidebar } from "./components/Sidebar.js";
import { Transcript } from "./components/Transcript.js";
import { filterSlashCommands, formatCommandDetail } from "./commands.js";
import { formatOllamaHost, formatTokens, normalizeModelAlias, readToggle } from "./format.js";
import { checkOllamaHost, discoverOllamaHosts, normalizeOllamaUrl, type OllamaHost } from "./hosts.js";
import { readGpuStats, readSystemStats, type GpuStats, type SystemStats } from "./systemStats.js";
import { maxTranscriptLines, type AdvisorNote, type AgentMode, type LogLine } from "./types.js";

export type PatchPilotAppProps = AgentRunnerOptions & {
  initialTask?: string;
};

export function App(props: PatchPilotAppProps): React.ReactElement {
  const { exit } = useApp();
  const [input, setInput] = useState(props.initialTask ?? "");
  const didRunInitialTask = useRef(false);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [advisorNotes, setAdvisorNotes] = useState<AdvisorNote[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState("idle");
  const [telemetry, setTelemetry] = useState<ModelTelemetry | null>(null);
  const [systemStats, setSystemStats] = useState<SystemStats>(() => readSystemStats().stats);
  const [gpuStats, setGpuStats] = useState<GpuStats | null>(null);
  const [agentMode, setAgentMode] = useState<AgentMode>(props.allowWrite || props.allowShell ? "build" : "plan");
  const [hostOptions, setHostOptions] = useState<OllamaHost[]>([]);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  const [settings, setSettings] = useState<AgentRunnerOptions>({
    provider: props.provider,
    model: props.model,
    ollamaUrl: props.ollamaUrl,
    workspace: props.workspace,
    allowWrite: props.allowWrite,
    allowShell: props.allowShell,
    maxSteps: props.maxSteps,
    subagents: props.subagents
  });

  const appendLine = useCallback((line: Omit<LogLine, "id">) => {
    setLines((currentLines) => [
      ...currentLines.slice(-maxTranscriptLines),
      {
        ...line,
        id: Date.now() + Math.random()
      }
    ]);
  }, []);

  const applyMode = useCallback(
    (nextMode: AgentMode, announce = true) => {
      setAgentMode(nextMode);
      setSettings((currentSettings) => ({
        ...currentSettings,
        allowWrite: nextMode === "build" ? currentSettings.allowWrite : false,
        allowShell: nextMode === "build" ? currentSettings.allowShell : false
      }));

      if (announce) {
        appendLine({
          tone: "success",
          label: "mode",
          text: `${nextMode} mode ${nextMode === "plan" ? "keeps tools read-only" : "uses enabled write/shell permissions"}`
        });
      }
    },
    [appendLine]
  );

  const toggleMode = useCallback(() => {
    applyMode(agentMode === "plan" ? "build" : "plan");
  }, [agentMode, applyMode]);

  const runTask = useCallback(
    async (task: string) => {
      if (!task.trim() || isRunning) {
        return;
      }

      setInput("");
      setIsRunning(true);
      appendLine({
        tone: "normal",
        label: "you",
        text: task
      });

      try {
        const runnableSettings = await resolveRunnableSettings(settings, appendLine, setModelOptions);
        if (!runnableSettings) {
          return;
        }

        const taskRunner = new AgentRunner(runnableSettings);
        for await (const event of taskRunner.run(task)) {
          if (event.type === "metrics") {
            setTelemetry(event.metrics);
            continue;
          }

          if (event.type === "subagent") {
            setTelemetry(event.metrics);
            setAdvisorNotes((currentNotes) =>
              upsertAdvisorNote(currentNotes, {
                role: event.role,
                message: event.message
              })
            );
          }

          setStatus(eventToStatus(event));
          appendLine(eventToLine(event));
        }
      } catch (error) {
        appendLine({
          tone: "danger",
          label: "error",
          text: error instanceof Error ? error.message : String(error)
        });
      } finally {
        setStatus("idle");
        setIsRunning(false);
      }
    },
    [appendLine, isRunning, settings]
  );

  const handleSlashCommand = useCallback(
    async (rawCommand: string) => {
      const [commandName = "", ...args] = rawCommand.slice(1).trim().split(/\s+/);
      const command = commandName.toLowerCase();

      switch (command) {
        case "":
        case "help":
          appendLine({
            tone: "accent",
            label: "commands",
            text: "Slash commands. Type / plus a few letters to filter.",
            detail: formatCommandDetail()
          });
          return;
        case "build":
        case "plan":
        case "mode": {
          const nextMode = command === "mode" ? args[0]?.toLowerCase() : command;
          if (nextMode !== "plan" && nextMode !== "build") {
            appendLine({
              tone: "accent",
              label: "mode",
              text: `current ${agentMode}. Use /mode plan, /mode build, or press tab.`
            });
            return;
          }

          applyMode(nextMode);
          return;
        }
        case "permissions":
        case "perms":
          appendLine({
            tone: "accent",
            label: "permissions",
            text: `write ${settings.allowWrite ? "on" : "off"} | shell ${settings.allowShell ? "on" : "off"} | subagents ${settings.subagents ? "on" : "off"}`
          });
          return;
        case "provider": {
          const nextProvider = args[0]?.toLowerCase();
          if (nextProvider !== "ollama" && nextProvider !== "gemini" && nextProvider !== "codex") {
            appendLine({
              tone: "accent",
              label: "provider",
              text: `current ${settings.provider}. Use /provider ollama, /provider gemini, or /provider codex.`
            });
            return;
          }

          const nextModel = defaultModelForProvider(nextProvider, settings.model);
          setTelemetry(null);
          setModelOptions([]);
          setSettings((currentSettings) => ({
            ...currentSettings,
            provider: nextProvider,
            model: nextModel
          }));
          saveDotEnvValues({
            PATCHPILOT_PROVIDER: nextProvider,
            PATCHPILOT_MODEL: nextModel
          });
          appendLine({
            tone: "success",
            label: "provider",
            text: `switched to ${nextProvider} using ${nextModel}`
          });
          return;
        }
        case "onboarding":
          setOnboarding({
            step: "provider"
          });
          appendLine({
            tone: "accent",
            label: "onboarding",
            text: "Choose a provider: type 1 for Ollama, 2 for Gemini, or 3 for Codex OAuth."
          });
          return;
        case "agents":
        case "subagents": {
          const subagentsEnabled = readToggle(args[0], !settings.subagents);
          setSettings((currentSettings) => ({
            ...currentSettings,
            subagents: subagentsEnabled
          }));
          appendLine({
            tone: "success",
            label: "agents",
            text: `planner/reviewer subagents ${subagentsEnabled ? "enabled" : "disabled"}`
          });
          return;
        }
        case "write":
        case "apply": {
          const writeEnabled = readToggle(args[0], !settings.allowWrite);
          if (writeEnabled) {
            setAgentMode("build");
          }

          setSettings((currentSettings) => ({
            ...currentSettings,
            allowWrite: writeEnabled
          }));
          appendLine({
            tone: "success",
            label: "write",
            text: `workspace writes ${writeEnabled ? "enabled" : "disabled"}`
          });
          return;
        }
        case "shell": {
          const shellEnabled = readToggle(args[0], !settings.allowShell);
          if (shellEnabled) {
            setAgentMode("build");
          }

          setSettings((currentSettings) => ({
            ...currentSettings,
            allowShell: shellEnabled
          }));
          appendLine({
            tone: "success",
            label: "shell",
            text: `shell commands ${shellEnabled ? "enabled" : "disabled"}`
          });
          return;
        }
        case "model": {
          const nextModel = normalizeModelAlias(args.join(" ").trim());
          if (!nextModel) {
            appendLine({
              tone: "accent",
              label: "model",
              text: settings.model,
              detail: modelOptions.length > 0 ? formatModelOptions(modelOptions, settings.model) : "Use /models to list installed models."
            });
            return;
          }

          await switchModel(settings.provider, nextModel, settings.ollamaUrl, settings.model, appendLine, setModelOptions, setSettings, setTelemetry);
          return;
        }
        case "models": {
          const requestedModel = args.join(" ").trim();
          if (requestedModel) {
            const installedModels = await loadKnownOrAvailableModels(settings.provider, settings.ollamaUrl, modelOptions, setModelOptions, appendLine);
            if (!installedModels) {
              return;
            }

            const modelIndex = Number.parseInt(requestedModel, 10);
            const selectedModel = Number.isInteger(modelIndex) ? installedModels[modelIndex - 1] : undefined;
            if (Number.isInteger(modelIndex) && !selectedModel) {
              appendLine({
                tone: "warning",
                label: "models",
                text: `No installed model at index ${modelIndex}.`,
                detail: installedModels.length > 0 ? formatModelOptions(installedModels, settings.model) : "No models installed."
              });
              return;
            }

            const nextModel = selectedModel ?? normalizeModelAlias(requestedModel);
            if (!nextModel) {
              appendLine({
                tone: "warning",
                label: "models",
                text: "No model selected. Use /models to list installed models, then /models 1."
              });
              return;
            }

            await switchModel(settings.provider, nextModel, settings.ollamaUrl, settings.model, appendLine, setModelOptions, setSettings, setTelemetry, installedModels);
            return;
          }

          appendLine({
            tone: "muted",
            label: "models",
            text: `loading ${settings.provider} models...`
          });

          try {
            const models = await loadAvailableModels(settings.provider, settings.ollamaUrl, setModelOptions);
            if (models.length === 0) {
              appendLine({
                tone: "warning",
                label: "models",
              text: `No ${settings.provider} models found.`,
              detail:
                settings.provider === "ollama"
                  ? "Pull one first, for example: ollama pull qwen2.5-coder:7b"
                  : settings.provider === "gemini"
                    ? "Check GEMINI_API_KEY in .env."
                    : "Run codex login first."
              });
              return;
            }

            appendLine({
              tone: "accent",
              label: "models",
              text: `Found ${models.length} installed model${models.length === 1 ? "" : "s"}. Select with /models 1 or /model <name>.`,
              detail: formatModelOptions(models, settings.model)
            });
          } catch (error) {
            appendLine({
              tone: "danger",
              label: "models",
              text: error instanceof Error ? error.message : String(error)
            });
          }
          return;
        }
        case "status":
          appendLine({
            tone: "accent",
            label: "status",
            text: `provider ${settings.provider} | model ${settings.model} | host ${settings.provider === "ollama" ? settings.ollamaUrl : `${settings.provider} oauth`} | compute ${settings.provider === "ollama" ? describeComputeTarget(settings.ollamaUrl).kind : "cloud"} | agents ${settings.subagents ? "on" : "off"} | write ${settings.allowWrite ? "on" : "off"} | shell ${settings.allowShell ? "on" : "off"} | ${formatTokens(telemetry)}`
          });
          return;
        case "connect":
        case "host":
        case "ollama":
          if (settings.provider !== "ollama") {
            appendLine({
              tone: "warning",
              label: "provider",
              text: "Ollama host switching is only available with /provider ollama."
            });
            return;
          }
          await handleConnectCommand(args, settings.ollamaUrl, appendLine, hostOptions, setHostOptions, setSettings, setTelemetry);
          return;
        case "hosts":
          appendLine({
            tone: "muted",
            label: "hosts",
            text: "Scanning LAN for real Ollama hosts..."
          });
          await loadHosts(settings.ollamaUrl, appendLine, setHostOptions);
          return;
        case "doctor": {
          appendLine({
            tone: "muted",
            label: "doctor",
            text: "checking local requirements..."
          });
          const doctorResults = await runDoctor(settings.provider, settings.ollamaUrl, settings.model);
          for (const result of doctorResults) {
            appendLine({
              tone: result.ok ? "success" : "danger",
              label: result.name,
              text: result.details
            });
          }
          return;
        }
        case "clear":
          setLines([]);
          setAdvisorNotes([]);
          setTelemetry(null);
          return;
        case "exit":
        case "quit":
        case "q":
          exit();
          return;
        default:
          appendLine({
            tone: "warning",
            label: "unknown",
            text: `/${command} is not a PatchPilot command. Type /help.`
          });
      }
    },
    [agentMode, appendLine, applyMode, exit, hostOptions, modelOptions, settings, telemetry]
  );

  const handleSubmit = useCallback(
    async (value: string) => {
      const nextValue = value.trim();
      if (!nextValue || isRunning) {
        return;
      }

      setInput("");
      if (nextValue.startsWith("/")) {
        await handleSlashCommand(nextValue);
        return;
      }

      if (onboarding) {
        await handleOnboardingSubmit(nextValue, onboarding, settings, appendLine, setSettings, setModelOptions, setTelemetry, setOnboarding);
        return;
      }

      await runTask(nextValue);
    },
    [appendLine, handleSlashCommand, isRunning, onboarding, runTask, settings]
  );

  useEffect(() => {
    if (!props.initialTask || didRunInitialTask.current) {
      return;
    }

    didRunInitialTask.current = true;
    void runTask(props.initialTask);
  }, [props.initialTask, runTask]);

  useInput((inputValue, key) => {
    if (!isRunning && key.tab) {
      toggleMode();
      return;
    }

    if (!isRunning && input.length === 0 && inputValue === "q") {
      exit();
    }
  });

  useEffect(() => {
    let previousSnapshot = readSystemStats().snapshot;
    const timer = setInterval(() => {
      const nextReading = readSystemStats(previousSnapshot);
      previousSnapshot = nextReading.snapshot;
      setSystemStats(nextReading.stats);
    }, 1000);

    return () => {
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let isMounted = true;

    async function updateGpuStats(): Promise<void> {
      const nextGpuStats = await readGpuStats();
      if (isMounted) {
        setGpuStats(nextGpuStats);
      }
    }

    void updateGpuStats();
    const timer = setInterval(() => {
      void updateGpuStats();
    }, 2500);

    return () => {
      isMounted = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Header
        model={settings.model}
        provider={settings.provider}
        workspace={settings.workspace}
        status={status}
        allowWrite={settings.allowWrite}
        allowShell={settings.allowShell}
        agentMode={agentMode}
        subagents={settings.subagents}
        ollamaUrl={settings.ollamaUrl}
        telemetry={telemetry}
        systemStats={systemStats}
        gpuStats={gpuStats}
      />

      <Box flexDirection="row">
        <Sidebar
          workspace={settings.workspace}
          model={settings.model}
          provider={settings.provider}
          ollamaUrl={settings.ollamaUrl}
          agentMode={agentMode}
          allowWrite={settings.allowWrite}
          allowShell={settings.allowShell}
          subagents={settings.subagents}
          telemetry={telemetry}
          advisors={advisorNotes}
        />
        <Box flexDirection="column" flexGrow={1}>
          <Transcript lines={lines} isRunning={isRunning} />
          <Composer
            input={input}
            isRunning={isRunning}
            mask={onboarding?.step === "gemini-key" ? "*" : undefined}
            onChange={setInput}
            onSubmit={(value) => void handleSubmit(value)}
          />
          <OnboardingPanel state={onboarding} />
          {!isRunning && input.startsWith("/") ? (
            <CommandSuggestions input={input} hostOptions={hostOptions} modelOptions={modelOptions} currentModel={settings.model} />
          ) : null}
          <FooterHints />
        </Box>
      </Box>
    </Box>
  );
}

async function loadAvailableModels(
  provider: ModelProvider,
  ollamaUrl: string,
  setModelOptions: React.Dispatch<React.SetStateAction<string[]>>
): Promise<string[]> {
  const models = await createModelClient({
    provider,
    ollamaUrl
  }).listModels();
  setModelOptions(models);
  return models;
}

async function handleOnboardingSubmit(
  value: string,
  onboarding: OnboardingState,
  settings: AgentRunnerOptions,
  appendLine: (line: Omit<LogLine, "id">) => void,
  setSettings: React.Dispatch<React.SetStateAction<AgentRunnerOptions>>,
  setModelOptions: React.Dispatch<React.SetStateAction<string[]>>,
  setTelemetry: React.Dispatch<React.SetStateAction<ModelTelemetry | null>>,
  setOnboarding: React.Dispatch<React.SetStateAction<OnboardingState | null>>
): Promise<void> {
  if (onboarding.step === "provider") {
    const provider = readOnboardingProvider(value);
    if (!provider) {
      appendLine({
        tone: "warning",
        label: "onboarding",
        text: "Type 1 or ollama, 2 or gemini, or 3 or codex."
      });
      return;
    }

    if (provider === "gemini") {
      setOnboarding({
        step: "gemini-key"
      });
      appendLine({
        tone: "accent",
        label: "onboarding",
        text: "Paste your Gemini API key. The input is masked and will be saved to .env."
      });
      return;
    }

    if (provider === "codex" && !hasCodexCliOAuth()) {
      setOnboarding({
        step: "codex-login"
      });
      appendLine({
        tone: "accent",
        label: "onboarding",
        text: "Run codex login in another terminal, then press Enter here."
      });
      return;
    }

    await enterModelSelection(provider, settings.ollamaUrl, settings.model, appendLine, setSettings, setModelOptions, setTelemetry, setOnboarding);
    return;
  }

  if (onboarding.step === "gemini-key") {
    const apiKey = value.trim();
    if (!apiKey) {
      appendLine({
        tone: "warning",
        label: "onboarding",
        text: "Gemini API key cannot be empty."
      });
      return;
    }

    process.env.GEMINI_API_KEY = apiKey;
    saveDotEnvValues({
      PATCHPILOT_PROVIDER: "gemini",
      PATCHPILOT_MODEL: defaultGeminiModel,
      GEMINI_API_KEY: apiKey
    });
    appendLine({
      tone: "success",
      label: "onboarding",
      text: "Gemini API key saved to .env."
    });
    await enterModelSelection("gemini", settings.ollamaUrl, defaultGeminiModel, appendLine, setSettings, setModelOptions, setTelemetry, setOnboarding);
    return;
  }

  if (onboarding.step === "codex-login") {
    if (!hasCodexCliOAuth()) {
      appendLine({
        tone: "warning",
        label: "onboarding",
        text: "Codex OAuth is still missing. Run codex login, then press Enter again."
      });
      return;
    }

    await enterModelSelection("codex", settings.ollamaUrl, defaultCodexModel, appendLine, setSettings, setModelOptions, setTelemetry, setOnboarding);
    return;
  }

  const selectedModel = selectModelFromInput(value, onboarding.models);
  if (!selectedModel) {
    appendLine({
      tone: "warning",
      label: "onboarding",
      text: "Unknown model selection. Type a listed number or exact model name."
    });
    return;
  }

  setTelemetry(null);
  setSettings((currentSettings) => ({
    ...currentSettings,
    provider: onboarding.provider,
    model: selectedModel
  }));
  saveDotEnvValues({
    PATCHPILOT_PROVIDER: onboarding.provider,
    PATCHPILOT_MODEL: selectedModel
  });
  setOnboarding(null);
  appendLine({
    tone: "success",
    label: "onboarding",
    text: `ready: ${onboarding.provider} using ${selectedModel}`
  });
}

async function enterModelSelection(
  provider: ModelProvider,
  ollamaUrl: string,
  currentModel: string,
  appendLine: (line: Omit<LogLine, "id">) => void,
  setSettings: React.Dispatch<React.SetStateAction<AgentRunnerOptions>>,
  setModelOptions: React.Dispatch<React.SetStateAction<string[]>>,
  setTelemetry: React.Dispatch<React.SetStateAction<ModelTelemetry | null>>,
  setOnboarding: React.Dispatch<React.SetStateAction<OnboardingState | null>>
): Promise<void> {
  setTelemetry(null);
  setSettings((currentSettings) => ({
    ...currentSettings,
    provider,
    model: defaultModelForProvider(provider, currentModel)
  }));

  try {
    const models = await loadAvailableModels(provider, ollamaUrl, setModelOptions);
    if (models.length === 0) {
      appendLine({
        tone: "warning",
        label: "onboarding",
        text:
          provider === "ollama"
            ? "No Ollama models found. Pull one first."
            : provider === "gemini"
              ? "No Gemini models listed. Check your API key."
              : "No Codex OAuth models listed."
      });
      setOnboarding(null);
      return;
    }

    setOnboarding({
      step: "model",
      provider,
      models
    });
    appendLine({
      tone: "accent",
      label: "onboarding",
      text: `Choose a ${provider} model by number or name.`,
      detail: formatModelOptions(models.slice(0, 12), defaultModelForProvider(provider, currentModel))
    });
  } catch (error) {
    appendLine({
      tone: "danger",
      label: "onboarding",
      text: error instanceof Error ? error.message : String(error)
    });
    setOnboarding(null);
  }
}

function readOnboardingProvider(value: string): ModelProvider | null {
  const normalizedValue = value.trim().toLowerCase();
  if (normalizedValue === "1" || normalizedValue === "ollama" || normalizedValue === "local") {
    return "ollama";
  }

  if (normalizedValue === "2" || normalizedValue === "gemini" || normalizedValue === "google") {
    return "gemini";
  }

  if (normalizedValue === "3" || normalizedValue === "codex" || normalizedValue === "openai-codex") {
    return "codex";
  }

  return null;
}

function selectModelFromInput(value: string, models: string[]): string | null {
  const modelIndex = Number.parseInt(value.trim(), 10);
  if (Number.isInteger(modelIndex)) {
    return models[modelIndex - 1] ?? null;
  }

  return models.includes(value.trim()) ? value.trim() : null;
}

async function loadKnownOrAvailableModels(
  provider: ModelProvider,
  ollamaUrl: string,
  modelOptions: string[],
  setModelOptions: React.Dispatch<React.SetStateAction<string[]>>,
  appendLine: (line: Omit<LogLine, "id">) => void
): Promise<string[] | null> {
  try {
    return modelOptions.length > 0 ? modelOptions : await loadAvailableModels(provider, ollamaUrl, setModelOptions);
  } catch (error) {
    appendLine({
      tone: "danger",
      label: "models",
      text: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

async function switchModel(
  provider: ModelProvider,
  nextModel: string,
  ollamaUrl: string,
  currentModel: string,
  appendLine: (line: Omit<LogLine, "id">) => void,
  setModelOptions: React.Dispatch<React.SetStateAction<string[]>>,
  setSettings: React.Dispatch<React.SetStateAction<AgentRunnerOptions>>,
  setTelemetry: React.Dispatch<React.SetStateAction<ModelTelemetry | null>>,
  knownModels?: string[]
): Promise<void> {
  const installedModels = knownModels ?? (await loadAvailableModels(provider, ollamaUrl, setModelOptions).catch((error: unknown) => {
    appendLine({
      tone: "danger",
      label: "models",
      text: error instanceof Error ? error.message : String(error)
    });
    return null;
  }));

  if (!installedModels) {
    return;
  }

  if (!installedModels.includes(nextModel)) {
    appendLine({
      tone: "warning",
      label: "model",
      text: `${nextModel} is not available for ${provider}.`,
      detail:
        installedModels.length > 0
          ? `Use /models and pick one of:\n${formatModelOptions(installedModels, currentModel)}`
          : provider === "ollama"
            ? "Pull a model first, for example: ollama pull qwen2.5-coder:7b"
            : provider === "gemini"
              ? "Check GEMINI_API_KEY in .env."
              : "Run codex login first."
    });
    return;
  }

  setTelemetry(null);
  setSettings((currentSettings) => ({
    ...currentSettings,
    model: nextModel
  }));
  saveDotEnvValues({
    PATCHPILOT_PROVIDER: provider,
    PATCHPILOT_MODEL: nextModel
  });
  appendLine({
    tone: "success",
    label: "model",
    text: `switched to ${nextModel}`
  });
}

async function handleConnectCommand(
  args: string[],
  currentOllamaUrl: string,
  appendLine: (line: Omit<LogLine, "id">) => void,
  hostOptions: OllamaHost[],
  setHostOptions: React.Dispatch<React.SetStateAction<OllamaHost[]>>,
  setSettings: React.Dispatch<React.SetStateAction<AgentRunnerOptions>>,
  setTelemetry: React.Dispatch<React.SetStateAction<ModelTelemetry | null>>
): Promise<void> {
  const requestedHost = args.join(" ").trim();
  if (!requestedHost) {
    appendLine({
      tone: "muted",
      label: "hosts",
      text: "Scanning LAN for real Ollama hosts..."
    });
    await loadHosts(currentOllamaUrl, appendLine, setHostOptions);
    return;
  }

  const hostIndex = Number.parseInt(requestedHost, 10);
  const selectedHost = Number.isInteger(hostIndex) ? hostOptions[hostIndex - 1] : undefined;
  const nextUrl = selectedHost ? selectedHost.url : normalizeOllamaUrl(requestedHost);

  appendLine({
    tone: "muted",
    label: "ollama",
    text: `checking ${nextUrl}...`
  });
  const verifiedHost = await checkOllamaHost(nextUrl, {
    label: selectedHost?.label,
    source: selectedHost?.source,
    timeoutMs: 1200
  });
  if (!verifiedHost) {
    appendLine({
      tone: "warning",
      label: "ollama",
      text: `No Ollama server answered at ${nextUrl}.`,
      detail: "Start Ollama.app or run ollama serve locally. For remote hosts, check the IP, firewall, and OLLAMA_HOST."
    });
    return;
  }

  setTelemetry(null);
  setSettings((currentSettings) => ({
    ...currentSettings,
    ollamaUrl: nextUrl
  }));
  appendLine({
    tone: "success",
    label: "ollama",
    text: `connected to ${verifiedHost.url}`,
    detail: `Ollama ${verifiedHost.version ?? "unknown version"} on ${verifiedHost.label}. Inference uses this host; workspace tools still run here.`
  });
}

async function loadHosts(
  currentOllamaUrl: string,
  appendLine: (line: Omit<LogLine, "id">) => void,
  setHostOptions: React.Dispatch<React.SetStateAction<OllamaHost[]>>
): Promise<void> {
  const hosts = await discoverOllamaHosts(currentOllamaUrl);
  setHostOptions(hosts);
  appendLine({
    tone: hosts.length > 0 ? "accent" : "warning",
    label: "hosts",
    text:
      hosts.length > 0
        ? `Found ${hosts.length} Ollama host${hosts.length === 1 ? "" : "s"}. Select with /connect 1 or type a host manually.`
        : "No reachable Ollama hosts found.",
    detail:
      hosts.length > 0
        ? formatHostOptions(hosts)
        : "Start Ollama locally, or expose a remote server with OLLAMA_HOST=0.0.0.0:11434 and check the firewall. Manual: /connect 192.168.x.x:11434"
  });
}

async function resolveRunnableSettings(
  settings: AgentRunnerOptions,
  appendLine: (line: Omit<LogLine, "id">) => void,
  setModelOptions: React.Dispatch<React.SetStateAction<string[]>>
): Promise<AgentRunnerOptions | null> {
  let installedModels: string[];
  try {
    installedModels = await loadAvailableModels(settings.provider, settings.ollamaUrl, setModelOptions);
  } catch (error) {
    appendLine({
      tone: "danger",
      label: settings.provider,
      text: error instanceof Error ? error.message : String(error)
    });
    return null;
  }

  if (installedModels.includes(settings.model)) {
    return settings;
  }

  appendLine({
    tone: "warning",
    label: "model",
    text: `${settings.model} is not available for ${settings.provider}.`,
    detail:
      installedModels.length > 0
        ? `Pick an installed model first:\n${formatModelOptions(installedModels, settings.model)}`
        : settings.provider === "ollama"
          ? "No models installed. Pull one first, for example: ollama pull qwen2.5-coder:7b"
          : settings.provider === "gemini"
            ? "No Gemini models listed. Check GEMINI_API_KEY in .env."
            : "Codex OAuth is not ready. Run codex login."
  });
  return null;
}

function defaultModelForProvider(provider: ModelProvider, currentModel: string): string {
  if (provider === "gemini") {
    return currentModel.startsWith("gemini-") ? currentModel : defaultGeminiModel;
  }

  if (provider === "codex") {
    return currentModel.includes("codex") || currentModel === "codex-mini-latest" ? currentModel : defaultCodexModel;
  }

  return currentModel.startsWith("gemini-") || currentModel.includes("codex") ? defaultOllamaModel : currentModel;
}

function upsertAdvisorNote(notes: AdvisorNote[], nextNote: AdvisorNote): AdvisorNote[] {
  const nextNotes = notes.filter((note) => note.role !== nextNote.role);
  return [...nextNotes, nextNote].slice(-2);
}

function eventToLine(event: AgentEvent): Omit<LogLine, "id"> {
  switch (event.type) {
    case "status":
      return {
        tone: "muted",
        label: "thinking",
        text: event.message
      };
    case "assistant":
      return {
        tone: "accent",
        label: "pilot",
        text: event.message
      };
    case "subagent":
      return {
        tone: "accent",
        label: event.role,
        text: "advisor brief updated",
        detail: event.message
      };
    case "tool":
      return {
        tone: event.ok ? "success" : "warning",
        label: event.name,
        text: event.summary
      };
    case "final":
      return {
        tone: "success",
        label: "final",
        text: event.message
      };
    case "error":
      return {
        tone: "danger",
        label: "error",
        text: event.message
      };
    case "metrics":
      return {
        tone: "muted",
        label: "metrics",
        text: formatTokens(event.metrics)
      };
  }
}

function eventToStatus(event: AgentEvent): string {
  if (event.type === "status") {
    return event.message;
  }

  if (event.type === "tool") {
    return `${event.name}: ${event.summary}`;
  }

  if (event.type === "subagent") {
    return `${event.role} subagent`;
  }

  return event.type;
}

function formatHostOptions(hosts: OllamaHost[]): string {
  return hosts
    .map((host, index) => {
      const version = host.version ? `  Ollama ${host.version}` : "";
      return `${index + 1}. ${host.label}  ${host.url}${version}`;
    })
    .join("\n");
}

function formatModelOptions(models: string[], currentModel: string): string {
  return models
    .map((model, index) => {
      const currentMarker = model === currentModel ? "  current" : "";
      return `${index + 1}. ${model}${currentMarker}`;
    })
    .join("\n");
}
