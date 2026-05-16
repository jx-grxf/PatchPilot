import React from "react";
import { Box, Text } from "ink";
import type { AgentWorkState, ModelProvider, ModelTelemetry, SessionTelemetry } from "../../core/types.js";
import { formatCost, formatGpuMemory, formatGpuUtilization, formatOllamaHost, formatSessionTokens, formatTokens, shortenMiddle, type InkColor } from "../format.js";
import type { OllamaHostDetails } from "../hosts.js";
import { modeDescription, modePermissionLabel } from "../modes.js";
import type { GpuStats, SystemStats } from "../systemStats.js";
import type { AgentMode, AdvisorNote } from "../types.js";

type SidebarLine = {
  text: string;
  color: InkColor;
  bold?: boolean;
};

export function Sidebar(props: {
  workspace: string;
  model: string;
  provider: ModelProvider;
  ollamaUrl: string;
  agentMode: AgentMode;
  allowWrite: boolean;
  allowShell: boolean;
  subagents: boolean;
  workState: AgentWorkState;
  sessionId: string;
  systemStats: SystemStats;
  gpuStats: GpuStats | null;
  telemetry: ModelTelemetry | null;
  sessionTelemetry: SessionTelemetry;
  draftTokens: number;
  advisors: AdvisorNote[];
  height: number;
  scrollOffset: number;
  isActive: boolean;
  activeHost: OllamaHostDetails | null;
}): React.ReactElement {
  const rows = buildSidebarRows(props);
  const visibleRowCount = Math.max(1, props.height - 2);
  const hasOverflow = rows.length > visibleRowCount;
  const contentRowCount = hasOverflow ? Math.max(1, visibleRowCount - 1) : visibleRowCount;
  const clampedOffset = clampScrollOffset(props.scrollOffset, rows.length, contentRowCount);
  const visibleRows = rows.slice(Math.max(0, rows.length - contentRowCount - clampedOffset), rows.length - clampedOffset);

  return (
    <Box width={32} height={props.height} overflowY="hidden" borderStyle="round" borderColor={props.isActive ? "cyan" : "gray"} flexDirection="column" paddingX={1} marginRight={1}>
      {visibleRows.map((row, index) => (
        <Text key={`${index}-${row.text}`} color={row.color} bold={row.bold} wrap="truncate">
          {row.text}
        </Text>
      ))}
      {hasOverflow ? (
        <Text color="gray" wrap="truncate">
          scroll {Math.max(1, rows.length - contentRowCount - clampedOffset + 1)}-{Math.min(rows.length, rows.length - clampedOffset)}/{rows.length}
        </Text>
      ) : null}
    </Box>
  );
}

function buildSidebarRows(props: {
  workspace: string;
  model: string;
  provider: ModelProvider;
  ollamaUrl: string;
  agentMode: AgentMode;
  allowWrite: boolean;
  allowShell: boolean;
  subagents: boolean;
  workState: AgentWorkState;
  sessionId: string;
  systemStats: SystemStats;
  gpuStats: GpuStats | null;
  telemetry: ModelTelemetry | null;
  sessionTelemetry: SessionTelemetry;
  draftTokens: number;
  advisors: AdvisorNote[];
  activeHost: OllamaHostDetails | null;
}): SidebarLine[] {
  const hostDeviceName = props.provider === "ollama" ? props.activeHost?.host.deviceName ?? formatOllamaHost(props.ollamaUrl) : `${props.provider} api`;
  const hostRoute = props.provider === "ollama" ? props.activeHost?.host.url ?? props.ollamaUrl : `${props.provider} cloud`;
  const hostNetwork = props.provider === "ollama" ? props.activeHost?.host.kind ?? "local" : "cloud";
  const hostVersion = props.activeHost?.host.version ?? "-";
  const hostModels = props.activeHost ? `${props.activeHost.models.length} available` : "-";
  const hostLoaded = props.activeHost?.runningModels.length ? props.activeHost.runningModels.map((model) => formatRunningModel(model)).join(", ") : "idle";
  const rows: SidebarLine[] = [
    section("Session"),
    row("state", props.workState.replace(/_/g, " "), props.workState === "error" ? "red" : props.workState === "waiting_approval" ? "yellow" : "green"),
    row("mode", formatMode(props.agentMode), modeColor(props.agentMode)),
    row("session", shortenMiddle(props.sessionId, 18), "cyan"),
    row("agents", props.subagents ? "on" : "off", props.subagents ? "cyan" : "gray"),
    spacer(),
    section("Permissions"),
    row("mode", formatMode(props.agentMode), modeColor(props.agentMode)),
    muted(modeDescription(props.agentMode)),
    row("write", modePermissionLabel(props.agentMode, "write"), permissionColor(props.agentMode)),
    row("shell", modePermissionLabel(props.agentMode, "shell"), permissionColor(props.agentMode)),
    spacer(),
    section("Model"),
    row("provider", props.provider, props.provider === "ollama" ? "green" : "cyan"),
    muted(shortenMiddle(props.model, 28)),
    spacer(),
    section("Host"),
    row("device", shortenMiddle(hostDeviceName, 19), "yellow"),
    row("network", hostNetwork, "green"),
    muted(shortenMiddle(hostRoute, 28)),
    muted(`version ${hostVersion}`),
    muted(`models  ${hostModels}`),
    ...wrapSidebarText(`loaded  ${hostLoaded}`),
    spacer(),
    section("Workspace"),
    ...wrapSidebarText(shortenMiddle(props.workspace, 58)),
    spacer(),
    section("Runtime"),
    muted(`cpu ${props.systemStats.cpuPercent}%  mem ${props.systemStats.memoryPercent}%/${props.systemStats.usedMemoryGb}G`),
    muted(`gpu ${formatGpuUtilization(props.gpuStats)}  vram ${formatGpuMemory(props.gpuStats)}`),
    muted(`draft ${props.draftTokens} tok`),
    ...wrapSidebarText(formatTokens(props.telemetry)),
    ...wrapSidebarText(formatSessionTokens(props.sessionTelemetry)),
    muted(formatCost(props.sessionTelemetry.estimatedCostUsd)),
    spacer(),
    section("Advisors")
  ];

  if (props.advisors.length === 0) {
    rows.push(muted("No advisor output yet."));
    return rows;
  }

  for (const advisor of props.advisors) {
    rows.push({
      text: advisor.role,
      color: "yellow"
    });
    rows.push(...summarizeAdvisorText(advisor.message));
    rows.push(spacer());
  }

  return rows;
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

function section(text: string): SidebarLine {
  return {
    text,
    color: "cyan",
    bold: true
  };
}

function row(label: string, value: string, color: InkColor): SidebarLine {
  return {
    text: `${label.padEnd(9)}${value}`,
    color
  };
}

function muted(text: string): SidebarLine {
  return {
    text,
    color: "gray"
  };
}

function spacer(): SidebarLine {
  return muted("");
}

function wrapSidebarText(value: string): SidebarLine[] {
  return wrapText(value, 28).map(muted);
}

function summarizeAdvisorText(value: string): SidebarLine[] {
  const summary = value
    .replace(/\*\*/g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" ");
  const rows = wrapText(summary || "Advisor brief available in transcript.", 28).slice(0, 4);
  return rows.map(muted);
}

function formatRunningModel(model: OllamaHostDetails["runningModels"][number]): string {
  const vram = model.sizeVramBytes ? ` ${Math.round((model.sizeVramBytes / 1024 ** 3) * 10) / 10}G vram` : "";
  return `${model.name}${vram}`;
}

function clampScrollOffset(offset: number, rowCount: number, visibleRowCount: number): number {
  return Math.max(0, Math.min(offset, Math.max(0, rowCount - visibleRowCount)));
}

function wrapText(value: string, width: number): string[] {
  return value
    .split(/\r?\n/)
    .flatMap((line) => wrapLine(line, width));
}

function wrapLine(value: string, width: number): string[] {
  const words = value.trimEnd().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return [""];
  }

  const rows: string[] = [];
  let currentRow = "";
  for (const word of words) {
    const nextRow = currentRow ? `${currentRow} ${word}` : word;
    if (nextRow.length <= width) {
      currentRow = nextRow;
      continue;
    }

    if (currentRow) {
      rows.push(currentRow);
    }
    currentRow = word.length > width ? shortenMiddle(word, width) : word;
  }

  if (currentRow) {
    rows.push(currentRow);
  }

  return rows;
}
