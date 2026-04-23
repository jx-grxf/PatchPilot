import React from "react";
import { Box, Text } from "ink";
import type { ModelProvider, ModelTelemetry, SessionTelemetry } from "../../core/types.js";
import { formatCost, formatOllamaHost, formatSessionTokens, formatTokens, shortenMiddle, type InkColor } from "../format.js";
import type { OllamaHostDetails } from "../hosts.js";
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
  telemetry: ModelTelemetry | null;
  sessionTelemetry: SessionTelemetry;
  draftTokens: number;
  advisors: AdvisorNote[];
  activeHost: OllamaHostDetails | null;
}): SidebarLine[] {
  const hostDeviceName = props.activeHost?.host.deviceName ?? (props.provider === "ollama" ? formatOllamaHost(props.ollamaUrl) : `${props.provider} oauth`);
  const hostRoute = props.activeHost?.host.url ?? props.ollamaUrl;
  const hostNetwork = props.activeHost?.host.kind ?? (props.provider === "ollama" ? "local" : "cloud");
  const hostVersion = props.activeHost?.host.version ?? "-";
  const hostModels = props.activeHost ? `${props.activeHost.models.length} available` : "-";
  const hostLoaded = props.activeHost?.runningModels.length ? props.activeHost.runningModels.join(", ") : "idle";
  const rows: SidebarLine[] = [
    section("Session"),
    row("provider", props.provider, props.provider === "ollama" ? "green" : "cyan"),
    row("mode", props.agentMode, props.agentMode === "build" ? "yellow" : "green"),
    row("write", props.allowWrite ? "on" : "off", props.allowWrite ? "green" : "red"),
    row("shell", props.allowShell ? "on" : "off", props.allowShell ? "green" : "red"),
    row("agents", props.subagents ? "on" : "off", props.subagents ? "cyan" : "gray"),
    spacer(),
    section("Host"),
    row("device", shortenMiddle(hostDeviceName, 19), "yellow"),
    row("network", hostNetwork, "green"),
    muted(shortenMiddle(hostRoute, 28)),
    muted(`version ${hostVersion}`),
    muted(`models  ${hostModels}`),
    ...wrapSidebarText(`loaded  ${hostLoaded}`),
    muted(shortenMiddle(props.model, 28)),
    spacer(),
    section("Workspace"),
    ...wrapSidebarText(shortenMiddle(props.workspace, 58)),
    spacer(),
    section("Telemetry"),
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
    rows.push(...wrapSidebarText(advisor.message));
    rows.push(spacer());
  }

  return rows;
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
