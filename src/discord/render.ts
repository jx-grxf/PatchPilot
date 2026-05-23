import type { AgentEvent, ApprovalRequest, ModelTelemetry, PermissionDecision, SessionTelemetry } from "../core/types.js";
import { addTelemetryToSession, emptySessionTelemetry } from "../core/tokenAccounting.js";

export type DiscordRunCounters = {
  telemetry: SessionTelemetry;
  toolCalls: number;
  approvals: number;
  deniedApprovals: number;
  lastTool?: string;
  lastStatus?: string;
};

export function emptyDiscordRunCounters(): DiscordRunCounters {
  return {
    telemetry: emptySessionTelemetry(),
    toolCalls: 0,
    approvals: 0,
    deniedApprovals: 0
  };
}

export function updateDiscordRunCounters(counters: DiscordRunCounters, event: AgentEvent): DiscordRunCounters {
  if (event.type === "metrics") {
    return {
      ...counters,
      telemetry: addTelemetryToSession(counters.telemetry, event.metrics)
    };
  }
  if (event.type === "tool") {
    return {
      ...counters,
      toolCalls: counters.toolCalls + 1,
      lastTool: `${event.name} ${event.ok ? "ok" : "failed"}`
    };
  }
  if (event.type === "approval") {
    return {
      ...counters,
      approvals: counters.approvals + (event.decision === "deny" ? 0 : 1),
      deniedApprovals: counters.deniedApprovals + (event.decision === "deny" ? 1 : 0)
    };
  }
  if (event.type === "status") {
    return {
      ...counters,
      lastStatus: event.message
    };
  }
  return counters;
}

export function formatDiscordEvent(event: AgentEvent): string | null {
  switch (event.type) {
    case "status":
      return `status: ${event.message}`;
    case "assistant":
      return `assistant: ${event.message}`;
    case "subagent":
      return `subagent/${event.role}: ${event.message}`;
    case "tool":
      return `tool/${event.name}: ${event.summary}`;
    case "todo":
      return `todo: ${event.summary}`;
    case "approval":
      return `approval/${event.request.tool}: ${event.decision}`;
    case "final":
      return event.message;
    case "error":
      return `error: ${event.message}`;
    case "metrics":
      return null;
  }
}

export function formatDiscordRunSummary(counters: DiscordRunCounters): string {
  return [
    `requests ${counters.telemetry.requests}`,
    `tokens ${counters.telemetry.totalTokens}`,
    `tools ${counters.toolCalls}`,
    `approvals ${counters.approvals}`,
    counters.deniedApprovals > 0 ? `denied ${counters.deniedApprovals}` : "",
    counters.lastTool ? `last tool ${counters.lastTool}` : ""
  ].filter(Boolean).join(" · ");
}

export function formatApprovalRequest(request: ApprovalRequest): string {
  return [
    `Approval needed for \`${request.tool}\` (${request.permission}, ${request.risk} risk).`,
    request.preview ? `Preview: ${clipDiscordText(request.preview, 900)}` : "",
    "Use the buttons below. If this times out, PatchPilot denies the tool."
  ].filter(Boolean).join("\n");
}

export function chunkDiscordMessage(text: string, maxLength = 1900): string[] {
  const normalized = text.trim();
  if (!normalized) {
    return [];
  }
  if (normalized.length <= maxLength) {
    return [normalized];
  }

  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > maxLength) {
    const slice = remaining.slice(0, maxLength);
    const breakIndex = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf(" "));
    const splitAt = breakIndex > 400 ? breakIndex : maxLength;
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

export function clipDiscordText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+$/g, "");
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function parseApprovalDecision(customId: string): PermissionDecision | null {
  if (customId.endsWith(":allow_once")) {
    return "allow_once";
  }
  if (customId.endsWith(":allow_session")) {
    return "allow_session";
  }
  if (customId.endsWith(":deny")) {
    return "deny";
  }
  return null;
}

export function formatTelemetry(telemetry: ModelTelemetry): string {
  return `${telemetry.totalTokens} tokens (${telemetry.promptTokens} in, ${telemetry.responseTokens} out)`;
}
