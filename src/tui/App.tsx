import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { AgentRunner, type AgentRunnerOptions } from "../core/agent.js";
import { describeComputeTarget } from "../core/compute.js";
import { runDoctor } from "../core/doctor.js";
import { OllamaClient } from "../core/ollama.js";
import type { AgentEvent, ModelTelemetry } from "../core/types.js";
import { filterSlashCommands, formatCommandDetail } from "./commands.js";
import { checkOllamaHost, discoverOllamaHosts, normalizeOllamaUrl, type OllamaHost } from "./hosts.js";
import { readGpuStats, readSystemStats, type GpuStats, type SystemStats } from "./systemStats.js";

export type PatchPilotAppProps = AgentRunnerOptions & {
  initialTask?: string;
};

type LogLine = {
  id: number;
  tone: "muted" | "normal" | "success" | "warning" | "danger" | "accent";
  label: string;
  text: string;
  detail?: string;
};

type AgentMode = "plan" | "build";

export function App(props: PatchPilotAppProps): React.ReactElement {
  const { exit } = useApp();
  const [input, setInput] = useState(props.initialTask ?? "");
  const didRunInitialTask = useRef(false);
  const [lines, setLines] = useState<LogLine[]>([]);
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
      ...currentLines.slice(-22),
      {
        ...line,
        id: Date.now() + Math.random()
      }
    ]);
  }, []);

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
              text: `current ${agentMode}. Use /mode plan or /mode build.`
            });
            return;
          }

          setAgentMode(nextMode);
          setSettings((currentSettings) => ({
            ...currentSettings,
            allowWrite: nextMode === "build" ? currentSettings.allowWrite : false,
            allowShell: nextMode === "build" ? currentSettings.allowShell : false
          }));
          appendLine({
            tone: "success",
            label: "mode",
            text: `${nextMode} mode ${nextMode === "plan" ? "keeps tools read-only" : "allows write/shell permissions when enabled"}`
          });
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
            subagents: readToggle(args[0], !currentSettings.subagents)
          }));
          appendLine({
            tone: "success",
            label: "agents",
            text: `planner/reviewer subagents ${subagentsEnabled ? "enabled" : "disabled"}`
          });
          return;
        }
        case "write":
        case "apply":
          if (readToggle(args[0], !settings.allowWrite)) {
            setAgentMode("build");
          }
          setSettings((currentSettings) => ({
            ...currentSettings,
            allowWrite: readToggle(args[0], !currentSettings.allowWrite)
          }));
          appendLine({
            tone: "success",
            label: "write",
            text: `workspace writes ${readToggle(args[0], !settings.allowWrite) ? "enabled" : "disabled"}`
          });
          return;
        case "shell":
          if (readToggle(args[0], !settings.allowShell)) {
            setAgentMode("build");
          }
          setSettings((currentSettings) => ({
            ...currentSettings,
            allowShell: readToggle(args[0], !currentSettings.allowShell)
          }));
          appendLine({
            tone: "success",
            label: "shell",
            text: `shell commands ${readToggle(args[0], !settings.allowShell) ? "enabled" : "disabled"}`
          });
          return;
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

          const installedModels = await loadInstalledModels(settings.ollamaUrl, setModelOptions).catch((error: unknown) => {
            appendLine({
              tone: "danger",
              label: "models",
              text: error instanceof Error ? error.message : String(error)
            });
            return null;
          });
          if (!installedModels) {
            return;
          }

          if (!installedModels.includes(nextModel)) {
            appendLine({
              tone: "warning",
              label: "model",
              text: `${nextModel} is not installed on ${formatOllamaHost(settings.ollamaUrl)}.`,
              detail:
                installedModels.length > 0
                  ? `Use /models and pick one of:\n${formatModelOptions(installedModels, settings.model)}`
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
          return;
        }
        case "models": {
          const requestedModel = args.join(" ").trim();
          if (requestedModel) {
            const modelIndex = Number.parseInt(requestedModel, 10);
            let installedModels: string[];
            try {
              installedModels =
                modelOptions.length > 0 ? modelOptions : await loadInstalledModels(settings.ollamaUrl, setModelOptions);
            } catch (error) {
              appendLine({
                tone: "danger",
                label: "models",
                text: error instanceof Error ? error.message : String(error)
              });
              return;
            }
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

            if (!installedModels.includes(nextModel)) {
              appendLine({
                tone: "warning",
                label: "models",
                text: `${nextModel} is not installed on ${formatOllamaHost(settings.ollamaUrl)}.`,
                detail: installedModels.length > 0 ? formatModelOptions(installedModels, settings.model) : "No models installed."
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
        case "ollama": {
          const requestedHost = args.join(" ").trim();
          if (!requestedHost) {
            appendLine({
              tone: "muted",
              label: "hosts",
              text: "Scanning LAN for real Ollama hosts..."
            });
            const hosts = await discoverOllamaHosts(settings.ollamaUrl);
            setHostOptions(hosts);
            if (hosts.length === 0) {
              appendLine({
                tone: "warning",
                label: "hosts",
                text: "No reachable Ollama hosts found.",
                detail:
                  "Start Ollama locally, or expose a remote server with OLLAMA_HOST=0.0.0.0:11434 and check the firewall. Manual: /connect 192.168.x.x:11434"
              });
              return;
            }

            appendLine({
              tone: "accent",
              label: "hosts",
              text: `Found ${hosts.length} Ollama host${hosts.length === 1 ? "" : "s"}. Select with /connect 1 or type a host manually.`,
              detail: formatHostOptions(hosts)
            });
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
          return;
        }
        case "hosts": {
          appendLine({
            tone: "muted",
            label: "hosts",
            text: "Scanning LAN for real Ollama hosts..."
          });
          const hosts = await discoverOllamaHosts(settings.ollamaUrl);
          setHostOptions(hosts);
          appendLine({
            tone: hosts.length > 0 ? "accent" : "warning",
            label: "hosts",
            text: hosts.length > 0 ? `Found ${hosts.length} Ollama host${hosts.length === 1 ? "" : "s"}.` : "No reachable Ollama hosts found.",
            detail: hosts.length > 0 ? formatHostOptions(hosts) : "Manual connect: /connect 192.168.x.x:11434"
          });
          return;
        }
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
    [agentMode, appendLine, exit, hostOptions, modelOptions, settings, telemetry]
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
    [appendLine, handleSlashCommand, isRunning, runTask]
  );

  useEffect(() => {
    if (!props.initialTask || didRunInitialTask.current) {
      return;
    }

    didRunInitialTask.current = true;
    void runTask(props.initialTask);
  }, [appendLine, props.initialTask, runTask]);

  useInput((inputValue) => {
    if (!isRunning && inputValue === "q") {
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

      <Box borderStyle="round" borderColor={isRunning ? "cyan" : "gray"} flexDirection="column" paddingX={1} minHeight={18}>
        {lines.length === 0 ? (
          <EmptyState />
        ) : (
          lines.map((line) => <TranscriptLine key={line.id} line={line} />)
        )}
      </Box>

      <Box marginTop={1}>
        <Text color={isRunning ? "yellow" : "cyan"}>{isRunning ? "running  " : "patch >  "}</Text>
        {isRunning ? (
          <Text color="gray">waiting for model or tool result...</Text>
        ) : (
          <TextInput value={input} onChange={setInput} onSubmit={(value) => void handleSubmit(value)} placeholder="Ask PatchPilot or type /help..." />
        )}
      </Box>

      {!isRunning && input.startsWith("/") ? <CommandSuggestions input={input} hostOptions={hostOptions} modelOptions={modelOptions} currentModel={settings.model} /> : null}

      <Box marginTop={1}>
        <Text color="gray">/models pick model  |  /connect switch compute  |  /agents toggle advisors  |  /help commands</Text>
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

function Header(props: {
  model: string;
  workspace: string;
  status: string;
  allowWrite: boolean;
  allowShell: boolean;
  agentMode: AgentMode;
  subagents: boolean;
  ollamaUrl: string;
  telemetry: ModelTelemetry | null;
  systemStats: SystemStats;
  gpuStats: GpuStats | null;
}): React.ReactElement {
  const computeTarget = describeComputeTarget(props.ollamaUrl);
  const memoryColor = usageColor(props.systemStats.memoryPercent);
  const modelHint = getModelHint(props.model);

  return (
    <Box borderStyle="round" borderColor={props.status === "idle" ? "cyan" : "yellow"} flexDirection="column" marginBottom={1} paddingX={1}>
      <Box justifyContent="space-between">
        <Box flexDirection="column">
          <Text color="cyan" bold>
            PatchPilot
            <Text color="gray">  local-first coding agent</Text>
          </Text>
          <Text color={modelHint.color} wrap="truncate">
            {modelHint.text}
          </Text>
        </Box>
        <Text color={props.status === "idle" ? "gray" : "yellow"} wrap="truncate">
          {shortenMiddle(props.status, 40)}
        </Text>
      </Box>
      <Box flexDirection="column">
        <HeaderMetricLine
          items={[
            ["model", shortenMiddle(props.model, 30), modelHint.color],
            ["host", shortenMiddle(formatOllamaHost(props.ollamaUrl), 22), "cyan"],
            ["compute", computeTarget.kind, computeTarget.kind === "remote" ? "yellow" : "green"],
            ["mode", props.agentMode, props.agentMode === "build" ? "yellow" : "green"],
            ["advisors", props.subagents ? "on" : "off", props.subagents ? "cyan" : "gray"],
            ["write", props.allowWrite ? "on" : "off", props.allowWrite ? "green" : "red"],
            ["shell", props.allowShell ? "on" : "off", props.allowShell ? "green" : "red"]
          ]}
        />
        <HeaderMetricLine
          items={[
            ["cpu", formatPercent(props.systemStats.cpuPercent), usageColor(props.systemStats.cpuPercent)],
            ["mem", `${props.systemStats.memoryPercent}%/${props.systemStats.usedMemoryGb}G`, memoryColor],
            ["gpu", formatGpuUtilization(props.gpuStats), usageColor(props.gpuStats?.utilizationPercent ?? null)],
            ["vram", formatGpuMemory(props.gpuStats), gpuMemoryColor(props.gpuStats)],
            ["temp", formatGpuTemperature(props.gpuStats), temperatureColor(props.gpuStats?.temperatureCelsius ?? null)],
            ["power", formatGpuPower(props.gpuStats), "cyan"]
          ]}
        />
        <HeaderMetricLine
          items={[
            ["tokens", shortenMiddle(formatTokens(props.telemetry), 36), "cyan"],
            ["speed", formatSpeed(props.telemetry), "cyan"],
            ["latency", formatLatency(props.telemetry), "cyan"]
          ]}
        />
      </Box>
      <Text color="gray" wrap="truncate">
        cwd {shortenMiddle(props.workspace, 96)}
      </Text>
    </Box>
  );
}

function getModelHint(model: string): { text: string; color: "green" | "yellow" } {
  if (/\bcoder\b|qwen.*coder|deepseek-coder|codestral|starcoder/i.test(model)) {
    return {
      text: "coding model ready",
      color: "green"
    };
  }

  return {
    text: "general model selected; coding reliability may be weak",
    color: "yellow"
  };
}

function HeaderMetricLine(props: {
  items: Array<[label: string, value: string, color: "gray" | "green" | "yellow" | "red" | "cyan"]>;
}): React.ReactElement {
  return (
    <Text wrap="truncate">
      {props.items.map(([label, value, color], index) => (
        <React.Fragment key={label}>
          {index > 0 ? <Text color="gray">   </Text> : null}
          <Text color="gray">{label} </Text>
          <Text color={color}>{value}</Text>
        </React.Fragment>
      ))}
    </Text>
  );
}

function EmptyState(): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text color="gray">No session activity yet.</Text>
      <Text color="gray">Ask for a repo summary, a focused patch, or type /help.</Text>
    </Box>
  );
}

function CommandSuggestions(props: {
  input: string;
  hostOptions: OllamaHost[];
  modelOptions: string[];
  currentModel: string;
}): React.ReactElement | null {
  const suggestions = filterSlashCommands(props.input);
  if (suggestions.length === 0) {
    return null;
  }

  const commandInput = props.input.trimStart();
  const hosts = commandInput.startsWith("/connect") ? props.hostOptions.slice(0, 5) : [];
  const models = commandInput.startsWith("/models") ? props.modelOptions.slice(0, 8) : [];

  return (
    <Box borderStyle="round" borderColor="gray" flexDirection="column" paddingX={1} marginTop={1}>
      {suggestions.slice(0, 6).map((command) => (
        <Box key={command.name}>
          <Box width={30}>
            <Text color="cyan">{command.usage}</Text>
          </Box>
          <Text color="gray">{command.description}</Text>
        </Box>
      ))}
      {hosts.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">Last scanned Ollama hosts</Text>
          {hosts.map((host, index) => (
            <Text key={host.url} color="gray">
              {index + 1}. {host.label} {host.url}
            </Text>
          ))}
        </Box>
      ) : null}
      {models.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">Last loaded Ollama models</Text>
          {models.map((model, index) => (
            <Text key={model} color={model === props.currentModel ? "green" : "gray"}>
              {index + 1}. {model}
              {model === props.currentModel ? "  current" : ""}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

function TranscriptLine(props: { line: LogLine }): React.ReactElement {
  const marker = toneToMarker(props.line.tone);
  const color = toneToColor(props.line.tone);

  return (
    <Box flexDirection="column" marginBottom={props.line.detail ? 1 : 0}>
      <Box>
        <Box width={3}>
          <Text color={color}>{marker}</Text>
        </Box>
        <Box width={13}>
          <Text color={color} bold>
            {props.line.label}
          </Text>
        </Box>
        <Text color={color} wrap="wrap">
          {props.line.text}
        </Text>
      </Box>
      {props.line.detail ? (
        <Box marginLeft={16}>
          <Text color="gray" wrap="wrap">
            {props.line.detail}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

function Stat(props: {
  label: string;
  value: string;
  color: "gray" | "green" | "yellow" | "red" | "cyan";
}): React.ReactElement {
  return (
    <Box marginRight={3}>
      <Text color="gray">{props.label}</Text>
      <Text color="gray"> </Text>
      <Text color={props.color}>{props.value}</Text>
      <Text>  </Text>
    </Box>
  );
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
        text: event.message
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

function toneToColor(tone: LogLine["tone"]): "gray" | "white" | "green" | "yellow" | "red" | "cyan" {
  switch (tone) {
    case "muted":
      return "gray";
    case "success":
      return "green";
    case "warning":
      return "yellow";
    case "danger":
      return "red";
    case "accent":
      return "cyan";
    case "normal":
      return "white";
  }
}

function toneToMarker(tone: LogLine["tone"]): string {
  switch (tone) {
    case "muted":
      return "-";
    case "success":
      return "+";
    case "warning":
      return "!";
    case "danger":
      return "x";
    case "accent":
      return ">";
    case "normal":
      return ":";
  }
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

function formatTokens(telemetry: ModelTelemetry | null): string {
  if (!telemetry) {
    return "-";
  }

  return `${telemetry.promptTokens} in/${telemetry.responseTokens} out/${telemetry.totalTokens} total`;
}

function formatSpeed(telemetry: ModelTelemetry | null): string {
  if (!telemetry?.evalTokensPerSecond) {
    return "-";
  }

  return `${telemetry.evalTokensPerSecond.toFixed(1)} tok/s`;
}

function formatLatency(telemetry: ModelTelemetry | null): string {
  if (!telemetry) {
    return "-";
  }

  return `${formatDuration(telemetry.totalDurationMs)}`;
}

function formatDuration(durationMs: number): string {
  if (durationMs >= 1000) {
    return `${(durationMs / 1000).toFixed(1)}s`;
  }

  return `${durationMs}ms`;
}

function formatPercent(value: number | null): string {
  return value === null ? "-" : `${value}%`;
}

function usageColor(value: number | null): "gray" | "green" | "yellow" | "red" {
  if (value === null) {
    return "gray";
  }

  if (value >= 85) {
    return "red";
  }

  if (value >= 65) {
    return "yellow";
  }

  return "green";
}

function gpuMemoryColor(stats: GpuStats | null): "gray" | "green" | "yellow" | "red" {
  if (!stats || stats.totalMemoryGb <= 0) {
    return "gray";
  }

  return usageColor(Math.round((stats.usedMemoryGb / stats.totalMemoryGb) * 100));
}

function temperatureColor(value: number | null): "gray" | "green" | "yellow" | "red" {
  if (value === null) {
    return "gray";
  }

  if (value >= 85) {
    return "red";
  }

  if (value >= 75) {
    return "yellow";
  }

  return "green";
}

function formatGpuUtilization(stats: GpuStats | null): string {
  return stats ? `${stats.utilizationPercent}%` : "-";
}

function formatGpuMemory(stats: GpuStats | null): string {
  return stats ? `${stats.usedMemoryGb}/${stats.totalMemoryGb}G` : "-";
}

function formatGpuTemperature(stats: GpuStats | null): string {
  return stats?.temperatureCelsius !== null && stats?.temperatureCelsius !== undefined ? `${stats.temperatureCelsius}C` : "-";
}

function formatGpuPower(stats: GpuStats | null): string {
  if (!stats?.powerDrawWatts) {
    return "-";
  }

  return stats.powerLimitWatts ? `${Math.round(stats.powerDrawWatts)}/${Math.round(stats.powerLimitWatts)}W` : `${Math.round(stats.powerDrawWatts)}W`;
}

function readToggle(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }

  const normalizedValue = value.toLowerCase();
  if (["on", "true", "yes", "1", "enable", "enabled"].includes(normalizedValue)) {
    return true;
  }

  if (["off", "false", "no", "0", "disable", "disabled"].includes(normalizedValue)) {
    return false;
  }

  return fallback;
}

function normalizeModelAlias(value: string): string {
  if (value === "uncensored" || value === "abliterate" || value === "abliterated") {
    return "huihui_ai/qwen2.5-coder-abliterate:7b";
  }

  if (value === "default" || value === "official") {
    return "qwen2.5-coder:7b";
  }

  return value;
}

function formatOllamaHost(value: string): string {
  if (!value) {
    return "not connected";
  }

  try {
    const url = new URL(value);
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
      return "local";
    }

    return url.host;
  } catch {
    return value;
  }
}

function shortenMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  if (maxLength <= 3) {
    return value.slice(0, maxLength);
  }

  const keep = maxLength - 3;
  const left = Math.ceil(keep / 2);
  const right = Math.floor(keep / 2);
  return `${value.slice(0, left)}...${value.slice(value.length - right)}`;
}
