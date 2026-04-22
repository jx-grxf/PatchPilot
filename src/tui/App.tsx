import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { AgentRunner, type AgentRunnerOptions } from "../core/agent.js";
import { runDoctor } from "../core/doctor.js";
import type { AgentEvent, ModelTelemetry } from "../core/types.js";
import { filterSlashCommands, formatCommandList, slashCommands } from "./commands.js";
import { discoverOllamaHosts, getOllamaHostCandidates, normalizeOllamaUrl } from "./hosts.js";
import { routeLocalConversation } from "./inputRouting.js";
import { isLocalOllamaUrl, isMacOS } from "./platform.js";
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
  const [lines, setLines] = useState<LogLine[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState("idle");
  const [telemetry, setTelemetry] = useState<ModelTelemetry | null>(null);
  const [systemStats, setSystemStats] = useState<SystemStats>(() => readSystemStats().stats);
  const [gpuStats, setGpuStats] = useState<GpuStats | null>(null);
  const [agentMode, setAgentMode] = useState<AgentMode>(props.allowWrite || props.allowShell ? "build" : "plan");
  const [notice, setNotice] = useState<string | null>(() =>
    isMacOS() && (!props.ollamaUrl || isLocalOllamaUrl(props.ollamaUrl))
      ? "macOS local models are not supported yet. Use /connect to use a remote Ollama host."
      : null
  );
  const [settings, setSettings] = useState<AgentRunnerOptions>({
    model: props.model,
    ollamaUrl: props.ollamaUrl,
    workspace: props.workspace,
    allowWrite: props.allowWrite,
    allowShell: props.allowShell,
    maxSteps: props.maxSteps
  });
  const runner = useMemo(() => new AgentRunner(settings), [settings]);

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

      if (isMacOS() && (!settings.ollamaUrl || isLocalOllamaUrl(settings.ollamaUrl))) {
        appendLine({
          tone: "warning",
          label: "ollama",
          text: "macOS local models are not supported yet. Connect to your PC with /connect <windows-pc-ip>:11434."
        });
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
        for await (const event of runner.run(task)) {
          if (event.type === "metrics") {
            setTelemetry(event.metrics);
            continue;
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
    [appendLine, isRunning, runner]
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
            text: formatCommandList()
          });
          return;
        case "mode": {
          const nextMode = args[0]?.toLowerCase();
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
            text: `write ${settings.allowWrite ? "on" : "off"} | shell ${settings.allowShell ? "on" : "off"}`
          });
          return;
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
              text: settings.model
            });
            return;
          }

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
        case "status":
          appendLine({
            tone: "accent",
            label: "status",
            text: `model ${settings.model} | host ${settings.ollamaUrl} | write ${settings.allowWrite ? "on" : "off"} | shell ${settings.allowShell ? "on" : "off"} | ${formatTokens(telemetry)}`
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
              text: "scanning LAN for Ollama hosts..."
            });
            const hosts = await discoverOllamaHosts(settings.ollamaUrl);
            appendLine({
              tone: "accent",
              label: "hosts",
              text: hosts.map((host, index) => `${index + 1}. ${host.label} ${host.url}`).join("  ")
            });
            return;
          }

          const hosts = getOllamaHostCandidates(settings.ollamaUrl);
          const hostIndex = Number.parseInt(requestedHost, 10);
          const nextUrl = Number.isInteger(hostIndex) && hosts[hostIndex - 1]
            ? hosts[hostIndex - 1].url
            : normalizeOllamaUrl(requestedHost);

          setTelemetry(null);
          setNotice(null);
          setSettings((currentSettings) => ({
            ...currentSettings,
            ollamaUrl: nextUrl
          }));
          appendLine({
            tone: "success",
            label: "ollama",
            text: `connected to ${nextUrl}`
          });
          return;
        }
        case "hosts": {
          const hosts = getOllamaHostCandidates(settings.ollamaUrl);
          appendLine({
            tone: "accent",
            label: "hosts",
            text: hosts.map((host, index) => `${index + 1}. ${host.label} ${host.url}`).join("  ")
          });
          return;
        }
        case "doctor": {
          appendLine({
            tone: "muted",
            label: "doctor",
            text: "checking local requirements..."
          });
          const doctorResults = await runDoctor(settings.ollamaUrl);
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
    [appendLine, exit, settings, telemetry]
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

      if (handleLocalConversation(nextValue, appendLine)) {
        return;
      }

      await runTask(nextValue);
    },
    [appendLine, handleSlashCommand, isRunning, runTask]
  );

  useEffect(() => {
    if (props.initialTask) {
      void runTask(props.initialTask);
    }
  }, [props.initialTask, runTask]);

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
        ollamaUrl={settings.ollamaUrl}
        telemetry={telemetry}
        systemStats={systemStats}
        gpuStats={gpuStats}
      />

      {notice ? (
        <Box marginBottom={1}>
          <Text color="yellow">{notice}</Text>
        </Box>
      ) : null}

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

      {!isRunning && input.startsWith("/") ? <CommandSuggestions input={input} ollamaUrl={settings.ollamaUrl} /> : null}

      <Box marginTop={1}>
        <Text color="gray">/help for commands  |  /write on enables edits  |  /shell on enables commands  |  /exit quits</Text>
      </Box>
    </Box>
  );
}

function Header(props: {
  model: string;
  workspace: string;
  status: string;
  allowWrite: boolean;
  allowShell: boolean;
  agentMode: AgentMode;
  ollamaUrl: string;
  telemetry: ModelTelemetry | null;
  systemStats: SystemStats;
  gpuStats: GpuStats | null;
}): React.ReactElement {
  return (
    <Box borderStyle="round" borderColor="cyan" flexDirection="column" marginBottom={1} paddingX={1}>
      <Box justifyContent="space-between">
        <Box>
          <Text color="cyan" bold>
            PatchPilot
          </Text>
          <Text color="gray"> local coding agent</Text>
        </Box>
        <Text color={props.status === "idle" ? "gray" : "yellow"}>{props.status}</Text>
      </Box>
      <Box marginTop={1}>
        <Stat label="model" value={props.model} color="green" />
        <Stat label="host" value={formatOllamaHost(props.ollamaUrl)} color="cyan" />
        <Stat label="mode" value={props.agentMode} color={props.agentMode === "build" ? "yellow" : "green"} />
        <Stat label="cpu" value={formatPercent(props.systemStats.cpuPercent)} color={usageColor(props.systemStats.cpuPercent)} />
        <Stat
          label="mem"
          value={`${props.systemStats.memoryPercent}%/${props.systemStats.usedMemoryGb}G`}
          color={usageColor(props.systemStats.memoryPercent)}
        />
        <Stat label="gpu" value={formatGpuUtilization(props.gpuStats)} color={usageColor(props.gpuStats?.utilizationPercent ?? null)} />
        <Stat label="vram" value={formatGpuMemory(props.gpuStats)} color={gpuMemoryColor(props.gpuStats)} />
        <Stat label="tokens" value={formatTokens(props.telemetry)} color="cyan" />
      </Box>
      <Box>
        <Stat label="temp" value={formatGpuTemperature(props.gpuStats)} color={temperatureColor(props.gpuStats?.temperatureCelsius ?? null)} />
        <Stat label="power" value={formatGpuPower(props.gpuStats)} color="cyan" />
        <Stat label="speed" value={formatSpeed(props.telemetry)} color="cyan" />
        <Stat label="latency" value={formatLatency(props.telemetry)} color="cyan" />
        <Stat label="write" value={props.allowWrite ? "on" : "off"} color={props.allowWrite ? "green" : "red"} />
        <Stat label="shell" value={props.allowShell ? "on" : "off"} color={props.allowShell ? "green" : "red"} />
      </Box>
      <Text color="gray">cwd {props.workspace}</Text>
    </Box>
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

function CommandSuggestions(props: { input: string; ollamaUrl: string }): React.ReactElement | null {
  const suggestions = filterSlashCommands(props.input);
  if (suggestions.length === 0) {
    return null;
  }

  const isConnectInput = props.input.trimStart().startsWith("/connect");
  const hosts = isConnectInput ? getOllamaHostCandidates(props.ollamaUrl).slice(0, 5) : [];

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
          <Text color="gray">Ollama hosts</Text>
          {hosts.map((host, index) => (
            <Text key={host.url} color="gray">
              {index + 1}. {host.label} {host.url}
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

function handleLocalConversation(task: string, appendLine: (line: Omit<LogLine, "id">) => void): boolean {
  const route = routeLocalConversation(task);
  if (route.handled) {
    appendLine({
      tone: "normal",
      label: "you",
      text: task
    });
    appendLine({
      tone: route.tone,
      label: "pilot",
      text: route.message
    });
    return true;
  }

  return false;
}
