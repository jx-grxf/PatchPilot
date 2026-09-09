import { describeComputeTarget } from "../core/compute.js";
import { formatThinkingSupport } from "../core/reasoning.js";
import { estimateCloudEquivalentCost } from "../core/tokenAccounting.js";
import type {
  AgentToolName,
  ModelProvider,
  ModelTelemetry,
  PermissionDecision,
  SessionTelemetry,
} from "../core/types.js";
import { formatCost, formatSessionTokens, formatTokens } from "./format.js";
import type { OllamaHostDetails } from "./hosts.js";
import { modePermissionLabel } from "./modes.js";
import type { AgentMode, ToolTelemetry } from "./types.js";

/**
 * Session counters and the strings built from them.
 *
 * These are pure functions over telemetry, with no React and no I/O, and they
 * lived inside the app component only because that is where they were first
 * needed. Out here they can be tested directly.
 */

export function emptyToolTelemetry(): ToolTelemetry {
  return {
    total: 0,
    succeeded: 0,
    failed: 0,
    approvals: 0,
    denied: 0,
    byTool: {}
  };
}

export function addToolTelemetry(current: ToolTelemetry, tool: AgentToolName | "subagent", ok: boolean): ToolTelemetry {
  return {
    ...current,
    total: current.total + 1,
    succeeded: current.succeeded + (ok ? 1 : 0),
    failed: current.failed + (ok ? 0 : 1),
    byTool: {
      ...current.byTool,
      [tool]: (current.byTool[tool] ?? 0) + 1
    }
  };
}

export function addApprovalTelemetry(current: ToolTelemetry, decision: PermissionDecision): ToolTelemetry {
  return {
    ...current,
    approvals: current.approvals + (decision === "deny" ? 0 : 1),
    denied: current.denied + (decision === "deny" ? 1 : 0)
  };
}

/**
 * Dense operational status dock for `/status` — restores the always-available
 * "what mode am I in and what can happen" view the legacy sidebar provided,
 * without spending fixed screen rows in the new shell's header.
 */
export function formatStatusDock(options: {
  provider: ModelProvider;
  model: string;
  agentMode: AgentMode;
  subagents: boolean;
  workspace: string;
  ollamaUrl: string;
  sessionId: string;
  activeHost: OllamaHostDetails | null;
  toolTelemetry: ToolTelemetry;
  sessionTelemetry: SessionTelemetry;
  telemetry: ModelTelemetry | null;
  draftTokens: number;
}): string {
  const isOllama = options.provider === "ollama";
  const hostLine = isOllama
    ? `${options.activeHost?.host.deviceName ?? "ollama"}  ${options.activeHost?.host.url ?? options.ollamaUrl}`
    : `${options.provider} api`;
  const computeKind = isOllama ? describeComputeTarget(options.ollamaUrl).kind : "local";
  // Thinking is the model's own; the dock reports what it supports, not a
  // setting the user has to maintain.
  const reasoning = formatThinkingSupport(options.provider, options.model, "auto");
  const toolCounters = Object.entries(options.toolTelemetry.byTool)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 6)
    .map(([tool, count]) => `${tool} ${count}`)
    .join(" · ");
  return [
    `provider   ${options.provider}/${options.model}`,
    `host       ${hostLine}  ·  compute ${computeKind}  ·  tools local`,
    `mode       ${options.agentMode}  ·  write ${modePermissionLabel(options.agentMode, "write")}  ·  shell ${modePermissionLabel(options.agentMode, "shell")}`,
    `model cfg  ${reasoning}  ·  subagents ${options.subagents ? "on" : "off"}`,
    `workspace  ${options.workspace}`,
    `session    ${options.sessionId}`,
    `tokens     draft ${options.draftTokens} · last ${formatTokens(options.telemetry)} · session ${formatSessionTokens(options.sessionTelemetry)} · cost ${formatCost(options.sessionTelemetry.estimatedCostUsd)}`,
    options.toolTelemetry.total > 0
      ? `tools      ${options.toolTelemetry.total} calls · ${options.toolTelemetry.succeeded} ok · ${options.toolTelemetry.failed} failed · ${options.toolTelemetry.approvals} approved · ${options.toolTelemetry.denied} denied`
      : "tools      none yet",
    toolCounters ? `counters   ${toolCounters}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatUsageSummary(options: {
  provider: ModelProvider;
  model: string;
  telemetry: ModelTelemetry | null;
  sessionTelemetry: SessionTelemetry;
  toolTelemetry: ToolTelemetry;
}): string {
  const session = options.sessionTelemetry;
  const cost = formatCost(session.estimatedCostUsd);
  const saved = estimateSessionSavings(session);
  const pricingNote = pricingSourceLabel(session.costSource, saved.source);
  return [
    `${session.requests} request${session.requests === 1 ? "" : "s"}`,
    `${session.promptTokens} in`,
    `${session.responseTokens} out`,
    `${session.cachedPromptTokens} cached`,
    `${options.toolTelemetry.total} tool call${options.toolTelemetry.total === 1 ? "" : "s"}`,
    `cost ${cost}`,
    saved.costUsd !== null ? `saved ${formatCost(saved.costUsd)}` : "saved -",
    pricingNote
  ].join(" · ");
}

export function formatUsageDetail(options: {
  provider: ModelProvider;
  model: string;
  sessionTelemetry: SessionTelemetry;
  toolTelemetry: ToolTelemetry;
}): string {
  const session = options.sessionTelemetry;
  const saved = estimateSessionSavings(session);
  const toolRows = Object.entries(options.toolTelemetry.byTool)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([tool, count]) => `${tool}: ${count}`)
    .join("\n");
  return [
    `model: ${options.provider}/${options.model}`,
    `tokens: ${session.promptTokens} input, ${session.responseTokens} output, ${session.cachedPromptTokens} cached, ${session.cacheWriteTokens} cache-write, ${session.totalTokens} total`,
    `cost: ${formatCost(session.estimatedCostUsd)} (${session.costSource})`,
    saved.costUsd !== null ? `lifetime saved this session: ${formatCost(saved.costUsd)} (${saved.source})` : "lifetime saved this session: -",
    options.toolTelemetry.total > 0
      ? `tools: ${options.toolTelemetry.total} total, ${options.toolTelemetry.succeeded} ok, ${options.toolTelemetry.failed} failed, ${options.toolTelemetry.approvals} approved, ${options.toolTelemetry.denied} denied`
      : "tools: none yet",
    toolRows ? `tool counters:\n${toolRows}` : "",
    session.costSource === "fallback-pricing" || saved.source === "fallback-pricing"
      ? "pricing note: exact model pricing was not available, so PatchPilot used a conservative general cloud-model estimate."
      : session.costSource === "unknown"
        ? "pricing note: exact pricing is unavailable for this provider/model."
        : ""
  ]
    .filter(Boolean)
    .join("\n");
}

export function estimateSessionSavings(session: SessionTelemetry): {
  costUsd: number | null;
  source: "api-pricing" | "fallback-pricing" | "unknown";
} {
  return {
    costUsd: estimateCloudEquivalentCost(session.promptTokens, session.responseTokens, session.cachedPromptTokens),
    source: "fallback-pricing"
  };
}

export function pricingSourceLabel(costSource: SessionTelemetry["costSource"], savedSource: "api-pricing" | "fallback-pricing" | "unknown"): string {
  if (costSource === "fallback-pricing" || savedSource === "fallback-pricing") {
    return "fallback pricing";
  }
  if (costSource === "unknown" && savedSource === "unknown") {
    return "pricing unknown";
  }
  if (costSource === "free-route") {
    return "free route";
  }
  if (costSource === "mixed") {
    return "mixed pricing";
  }
  return "priced";
}
