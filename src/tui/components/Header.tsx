import React from "react";
import { Box, Text } from "ink";
import type { AgentWorkState, ModelProvider, ModelTelemetry, SessionTelemetry } from "../../core/types.js";
import { formatCost, formatLatency, formatSessionTokens, formatSpeed, getModelHint, shortenMiddle, type InkColor } from "../format.js";
import type { OllamaHostDetails } from "../hosts.js";
import { modePermissionLabel } from "../modes.js";
import type { GpuStats, SystemStats } from "../systemStats.js";
import type { AgentMode } from "../types.js";

export function Header(props: {
  model: string;
  provider: ModelProvider;
  workspace: string;
  status: string;
  workState: AgentWorkState;
  allowWrite: boolean;
  allowShell: boolean;
  agentMode: AgentMode;
  subagents: boolean;
  thinkingMode: "fixed" | "adaptive";
  reasoningEffort: string;
  ollamaUrl: string;
  telemetry: ModelTelemetry | null;
  sessionTelemetry: SessionTelemetry;
  draftTokens: number;
  systemStats: SystemStats;
  gpuStats: GpuStats | null;
  activeHost: OllamaHostDetails | null;
}): React.ReactElement {
  const modelHint = getModelHint(props.model);
  const stateColor = workStateColor(props.workState);
  const hostLabel = props.provider === "ollama" ? props.activeHost?.host.deviceName ?? "ollama" : `${props.provider} api`;

  return (
    <Box borderStyle="round" borderColor={stateColor} flexDirection="column" marginBottom={1} paddingX={1}>
      <Box justifyContent="space-between">
        <Text color="cyan" bold>
          PatchPilot <Text color="gray">agent workspace</Text>
        </Text>
        <Text color={stateColor}>{formatWorkState(props.workState)}</Text>
      </Box>
      <Text color={modelHint.color} wrap="truncate">
        {props.provider}/{shortenMiddle(props.model, 34)} <Text color="gray">on</Text> {shortenMiddle(hostLabel, 20)} <Text color="gray">mode</Text>{" "}
        <Text color={modeColor(props.agentMode)}>{formatMode(props.agentMode)}</Text>{" "}
        <Text color="gray">write</Text> <Text color={permissionColor(props.agentMode)}>{modePermissionLabel(props.agentMode, "write")}</Text>{" "}
        <Text color="gray">shell</Text> <Text color={permissionColor(props.agentMode)}>{modePermissionLabel(props.agentMode, "shell")}</Text>
      </Text>
      <Text color="gray" wrap="truncate">
        {shortenMiddle(props.status, 58)}  {formatSessionTokens(props.sessionTelemetry)}  {formatCost(props.sessionTelemetry.estimatedCostUsd)}  {formatSpeed(props.telemetry)} {formatLatency(props.telemetry)}
      </Text>
    </Box>
  );
}

function formatMode(agentMode: AgentMode): string {
  return agentMode === "bypass" ? "build+bypass" : agentMode;
}

function modeColor(agentMode: AgentMode): InkColor {
  if (agentMode === "bypass") {
    return "red";
  }

  return agentMode === "build" ? "yellow" : "green";
}

function permissionColor(agentMode: AgentMode): InkColor {
  if (agentMode === "bypass") {
    return "red";
  }

  return agentMode === "build" ? "yellow" : "gray";
}

function formatWorkState(workState: AgentWorkState): string {
  return workState.replace(/_/g, " ");
}

function workStateColor(workState: AgentWorkState): InkColor {
  if (workState === "error") {
    return "red";
  }

  if (workState === "waiting_approval" || workState === "editing" || workState === "verifying") {
    return "yellow";
  }

  if (workState === "done" || workState === "idle") {
    return "green";
  }

  return "cyan";
}
