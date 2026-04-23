import React from "react";
import { Box, Text } from "ink";
import { describeComputeTarget } from "../../core/compute.js";
import type { ModelTelemetry } from "../../core/types.js";
import type { ModelProvider } from "../../core/types.js";
import {
  formatGpuMemory,
  formatGpuPower,
  formatGpuTemperature,
  formatGpuUtilization,
  formatLatency,
  formatOllamaHost,
  formatPercent,
  formatSpeed,
  formatTokens,
  getModelHint,
  gpuMemoryColor,
  shortenMiddle,
  temperatureColor,
  usageColor,
  type StatusColor
} from "../format.js";
import type { GpuStats, SystemStats } from "../systemStats.js";
import type { AgentMode } from "../types.js";

export function Header(props: {
  model: string;
  provider: ModelProvider;
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
  const computeTarget = props.provider === "gemini" ? { kind: "cloud" } : describeComputeTarget(props.ollamaUrl);
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
            ["provider", props.provider, props.provider === "gemini" ? "cyan" : "green"],
            ["model", shortenMiddle(props.model, 30), modelHint.color],
            ["host", props.provider === "gemini" ? "gemini api" : shortenMiddle(formatOllamaHost(props.ollamaUrl), 22), "cyan"],
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

function HeaderMetricLine(props: { items: Array<[label: string, value: string, color: StatusColor]> }): React.ReactElement {
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
