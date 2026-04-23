import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, useApp, useInput } from "ink";
import { AgentRunner, type AgentRunnerOptions } from "../core/agent.js";
import { describeComputeTarget } from "../core/compute.js";
import { runDoctor } from "../core/doctor.js";
import { OllamaClient } from "../core/ollama.js";
import type { AgentEvent, ModelTelemetry } from "../core/types.js";
import { CommandSuggestions } from "./components/CommandSuggestions.js";
import { Composer, FooterHints } from "./components/Composer.js";
import { Header } from "./components/Header.js";
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
  const [settings, setSettings] = useState<AgentRunnerOptions>({
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

          await switchModel(nextModel, settings.ollamaUrl, settings.model, appendLine, setModelOptions, setSettings, setTelemetry);
          return;
        }
        case "models": {
          const requestedModel = args.join(" ").trim();
          if (requestedModel) {
            const installedModels = await loadKnownOrInstalledModels(settings.ollamaUrl, modelOptions, setModelOptions, appendLine);
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

            await switchModel(nextModel, settings.ollamaUrl, settings.model, appendLine, setModelOptions, setSettings, setTelemetry, installedModels);
            return;
          }

          appendLine({
            tone: "muted",
            label: "models",
            text: `loading models from ${formatOllamaHost(settings.ollamaUrl)}...`
          });

          try {
            const models = await loadInstalledModels(settings.ollamaUrl, setModelOptions);
            if (models.length === 0) {
              appendLine({
                tone: "warning",
                label: "models",
                text: "No installed Ollama models found on the selected host.",
                detail: "Pull one first, for example: ollama pull qwen2.5-coder:7b"
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
            text: `model ${settings.model} | host ${settings.ollamaUrl} | compute ${describeComputeTarget(settings.ollamaUrl).kind} | agents ${settings.subagents ? "on" : "off"} | write ${settings.allowWrite ? "on" : "off"} | shell ${settings.allowShell ? "on" : "off"} | ${formatTokens(telemetry)}`
          });
          return;
        case "connect":
        case "host":
        case "ollama":
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
          const doctorResults = await runDoctor(settings.ollamaUrl, settings.model);
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

      await runTask(nextValue);
    },
    [handleSlashCommand, isRunning, runTask]
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
          <Composer input={input} isRunning={isRunning} onChange={setInput} onSubmit={(value) => void handleSubmit(value)} />
          {!isRunning && input.startsWith("/") ? (
            <CommandSuggestions input={input} hostOptions={hostOptions} modelOptions={modelOptions} currentModel={settings.model} />
          ) : null}
          <FooterHints />
        </Box>
      </Box>
    </Box>
  );
}

async function loadInstalledModels(
  ollamaUrl: string,
  setModelOptions: React.Dispatch<React.SetStateAction<string[]>>
): Promise<string[]> {
  const models = await new OllamaClient(ollamaUrl).listModels();
  setModelOptions(models);
  return models;
}

async function loadKnownOrInstalledModels(
  ollamaUrl: string,
  modelOptions: string[],
  setModelOptions: React.Dispatch<React.SetStateAction<string[]>>,
  appendLine: (line: Omit<LogLine, "id">) => void
): Promise<string[] | null> {
  try {
    return modelOptions.length > 0 ? modelOptions : await loadInstalledModels(ollamaUrl, setModelOptions);
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
  nextModel: string,
  ollamaUrl: string,
  currentModel: string,
  appendLine: (line: Omit<LogLine, "id">) => void,
  setModelOptions: React.Dispatch<React.SetStateAction<string[]>>,
  setSettings: React.Dispatch<React.SetStateAction<AgentRunnerOptions>>,
  setTelemetry: React.Dispatch<React.SetStateAction<ModelTelemetry | null>>,
  knownModels?: string[]
): Promise<void> {
  const installedModels = knownModels ?? (await loadInstalledModels(ollamaUrl, setModelOptions).catch((error: unknown) => {
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
      text: `${nextModel} is not installed on ${formatOllamaHost(ollamaUrl)}.`,
      detail:
        installedModels.length > 0
          ? `Use /models and pick one of:\n${formatModelOptions(installedModels, currentModel)}`
          : "Pull a model first, for example: ollama pull qwen2.5-coder:7b"
    });
    return;
  }

  setTelemetry(null);
  setSettings((currentSettings) => ({
    ...currentSettings,
    model: nextModel
  }));
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
    installedModels = await loadInstalledModels(settings.ollamaUrl, setModelOptions);
  } catch (error) {
    appendLine({
      tone: "danger",
      label: "ollama",
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
    text: `${settings.model} is not installed on ${formatOllamaHost(settings.ollamaUrl)}.`,
    detail:
      installedModels.length > 0
        ? `Pick an installed model first:\n${formatModelOptions(installedModels, settings.model)}`
        : "No models installed. Pull one first, for example: ollama pull qwen2.5-coder:7b"
  });
  return null;
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
