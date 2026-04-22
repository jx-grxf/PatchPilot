import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { AgentRunner, type AgentRunnerOptions } from "../core/agent.js";
import type { AgentEvent, ModelTelemetry } from "../core/types.js";
import { readSystemStats, type SystemStats } from "./systemStats.js";

export type PatchPilotAppProps = AgentRunnerOptions & {
  initialTask?: string;
};

type LogLine = {
  id: number;
  tone: "muted" | "normal" | "success" | "warning" | "danger" | "accent";
  label: string;
  text: string;
};

export function App(props: PatchPilotAppProps): React.ReactElement {
  const { exit } = useApp();
  const [input, setInput] = useState(props.initialTask ?? "");
  const [lines, setLines] = useState<LogLine[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState("idle");
  const [telemetry, setTelemetry] = useState<ModelTelemetry | null>(null);
  const [systemStats, setSystemStats] = useState<SystemStats>(() => readSystemStats().stats);
  const runner = useMemo(() => new AgentRunner(props), [props]);

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

  return (
    <Box flexDirection="column" paddingX={1}>
      <Header
        model={props.model}
        workspace={props.workspace}
        status={status}
        allowWrite={props.allowWrite}
        allowShell={props.allowShell}
        telemetry={telemetry}
        systemStats={systemStats}
      />

      <Box borderStyle="round" borderColor="gray" flexDirection="column" paddingX={1} minHeight={18}>
        {lines.length === 0 ? (
          <Text color="gray">Ask PatchPilot to inspect, edit, or test this workspace.</Text>
        ) : (
          lines.map((line) => (
            <Box key={line.id}>
              <Text color={toneToColor(line.tone)} bold>
                {line.label.padEnd(9)}
              </Text>
              <Text color={toneToColor(line.tone)}>{line.text}</Text>
            </Box>
          ))
        )}
      </Box>

      <Box marginTop={1}>
        <Text color={isRunning ? "yellow" : "cyan"}>{isRunning ? "running " : "prompt  "}</Text>
        {isRunning ? (
          <Text color="gray">waiting for model/tool result...</Text>
        ) : (
          <TextInput value={input} onChange={setInput} onSubmit={(value) => void runTask(value)} placeholder="Describe the patch..." />
        )}
      </Box>

      <Box marginTop={1}>
        <Text color="gray">Press q to quit when idle. Use --apply for writes and --allow-shell for commands.</Text>
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
  telemetry: ModelTelemetry | null;
  systemStats: SystemStats;
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color="cyan" bold>
          PatchPilot
        </Text>
        <Text color="gray"> local coding agent</Text>
      </Box>
      <Box>
        <Text color="gray">model </Text>
        <Text color="green">{props.model}</Text>
        <Text color="gray">  status </Text>
        <Text color={props.status === "idle" ? "gray" : "yellow"}>{props.status}</Text>
      </Box>
      <Box>
        <Text color="gray">cpu </Text>
        <Text color={usageColor(props.systemStats.cpuPercent)}>{formatPercent(props.systemStats.cpuPercent)}</Text>
        <Text color="gray">  mem </Text>
        <Text color={usageColor(props.systemStats.memoryPercent)}>
          {props.systemStats.memoryPercent}%/{props.systemStats.usedMemoryGb}G
        </Text>
        <Text color="gray">  tokens </Text>
        <Text color="cyan">{formatTokens(props.telemetry)}</Text>
        <Text color="gray">  speed </Text>
        <Text color="cyan">{formatSpeed(props.telemetry)}</Text>
        <Text color="gray">  latency </Text>
        <Text color="cyan">{formatLatency(props.telemetry)}</Text>
      </Box>
      <Box>
        <Text color="gray">  write </Text>
        <Text color={props.allowWrite ? "green" : "red"}>{props.allowWrite ? "on" : "off"}</Text>
        <Text color="gray">  shell </Text>
        <Text color={props.allowShell ? "green" : "red"}>{props.allowShell ? "on" : "off"}</Text>
      </Box>
      <Text color="gray">workspace {props.workspace}</Text>
    </Box>
  );
}

function eventToLine(event: AgentEvent): Omit<LogLine, "id"> {
  switch (event.type) {
    case "status":
      return {
        tone: "muted",
        label: "status",
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
