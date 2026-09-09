import type { AgentEvent, AgentToolName, AgentWorkState } from "../core/types.js";
import { getToolSpec } from "../core/workspace.js";
import { formatTokens } from "./format.js";
import type { LogLineInput } from "./types.js";

/**
 * Turning agent events into transcript entries and status text.
 *
 * The mapping is exhaustive over the event union on purpose: adding an event
 * without deciding how it reads is a compile error rather than a silent gap in
 * the transcript.
 */

/**
 * A percentage alone hides whether there is room for the next tool result, so
 * the meter shows the raw token counts alongside it.
 */
export function formatContextUsage(usedTokens: number, limitTokens: number, ratio: number): string {
  return `${formatTokenCount(usedTokens)}/${formatTokenCount(limitTokens)} · ${Math.round(ratio * 100)}%`;
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }

  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

/** Live progress within the current model call, or null when idle. */
export type StreamProgress = {
  phase: "prompt" | "generating";
  elapsedMs: number;
  tokens: number;
  tokensPerSecond: number | null;
  /** Set while the model is writing a tool call rather than prose. */
  writing?: { tool: string; chars: number } | null;
};

/**
 * Prompt evaluation and generation are different waits and deserve different
 * words: during the first there is nothing to show but elapsed time, during
 * the second the throughput is the interesting number.
 */
export function formatStreamProgress(
  phase: "prompt" | "generating",
  elapsedMs: number,
  tokens: number,
  tokensPerSecond: number | null
): string {
  if (phase === "prompt") {
    return `reading prompt · ${formatDuration(elapsedMs)}`;
  }

  const rate = tokensPerSecond === null ? null : `${tokensPerSecond.toFixed(1)} tok/s`;
  return [`writing · ${tokens} tok`, rate, formatDuration(elapsedMs)].filter(Boolean).join(" · ");
}

export function formatDuration(elapsedMs: number): string {
  const seconds = elapsedMs / 1000;
  if (seconds < 10) {
    return `${seconds.toFixed(1)}s`;
  }

  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }

  return `${Math.floor(seconds / 60)}m${String(Math.round(seconds % 60)).padStart(2, "0")}s`;
}

export function randomLegacyVerbIndex(): number {
  return Math.floor(Math.random() * 1_000_000);
}

export function eventToLine(event: AgentEvent): LogLineInput {
  switch (event.type) {
    case "status":
      return {
        kind: "status",
        tone: "muted",
        label: event.workState,
        text: event.message,
        workState: event.workState
      };
    case "assistant":
      return {
        kind: "assistant",
        tone: "accent",
        label: "pilot",
        text: event.message,
        workState: event.workState
      };
    case "context":
      // Drives the meter, never a transcript line.
      return {
        kind: "status",
        tone: event.pressure === "critical" ? "danger" : event.pressure === "high" ? "warning" : "muted",
        label: "context",
        text: formatContextUsage(event.usedTokens, event.limitTokens, event.ratio),
        workState: event.workState
      };
    case "thinking":
      return {
        kind: "thinking",
        tone: "muted",
        label: "thinking",
        text: event.message,
        workState: event.workState
      };
    case "stream":
      // Handled as live status, never appended; this keeps the switch total.
      return {
        kind: "status",
        tone: "muted",
        label: event.workState,
        text: formatStreamProgress(event.phase, event.elapsedMs, event.tokens, event.tokensPerSecond),
        workState: event.workState
      };
    case "tool": {
      const subagentType = typeof event.metadata?.subagent === "string" ? event.metadata.subagent : null;
      return {
        kind: event.name === "git_diff" ? "diff" : "tool",
        tone: event.ok ? "success" : "warning",
        label: subagentType ? `${subagentType} agent` : event.name,
        text: event.summary,
        detail: event.ok ? previewToolContent(event.content) : event.content,
        workState: event.workState,
        tool: event.name === "subagent" ? undefined : event.name,
        toolCallId: event.toolCallId,
        category: event.category,
        preview: event.preview
      };
    }
    case "todo":
      return {
        kind: "status",
        tone: "muted",
        label: "todo",
        text: event.summary,
        workState: event.workState
      };
    case "approval":
      return {
        kind: "approval",
        tone: event.decision === "deny" ? "warning" : "success",
        label: "approval",
        text: `${event.request.tool} ${event.decision.replace("_", " ")}`,
        detail: event.request.preview,
        workState: event.workState,
        tool: event.request.tool,
        preview: event.request.preview
      };
    case "final":
      return {
        kind: "final",
        tone: "success",
        label: "final",
        text: event.message,
        workState: event.workState
      };
    case "error":
      return {
        kind: "error",
        tone: "danger",
        label: "error",
        text: event.message,
        workState: event.workState
      };
    case "metrics":
      return {
        kind: "status",
        tone: "muted",
        label: "metrics",
        text: formatTokens(event.metrics),
        workState: event.workState
      };
  }
}

function previewToolContent(content: string | undefined): string | undefined {
  const value = content?.trim();
  if (!value) {
    return undefined;
  }

  const lines = value.split(/\r?\n/);
  const preview = lines.slice(0, 6).join("\n");
  const suffix = lines.length > 6 ? `\n...[${lines.length - 6} more lines]` : "";
  return `${preview}${suffix}`;
}

export function eventToStatus(event: AgentEvent): string {
  if (event.type === "status") {
    return event.message;
  }

  if (event.type === "stream") {
    return formatStreamProgress(event.phase, event.elapsedMs, event.tokens, event.tokensPerSecond);
  }

  if (event.type === "thinking") {
    return "thinking";
  }

  if (event.type === "tool") {
    return `${event.name}: ${event.summary}`;
  }

  if (event.type === "todo") {
    return event.summary;
  }

  if (event.type === "approval") {
    return `${event.request.tool}: ${event.decision.replace("_", " ")}`;
  }

  return event.type;
}
