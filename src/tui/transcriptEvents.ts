import type { AgentEvent, AgentEventToolName, PermissionDecision } from "../core/types.js";
import { formatTokens } from "./format.js";
import { describeToolTarget, toolVerb } from "./toolDisplay.js";
import { formatCompactTokens } from "./format.js";
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

function formatTokenCount(tokens: number): string {
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
  writing?: { tool: string; chars: number; path?: string; preview?: string } | null;
};

/**
 * Prompt evaluation and generation are different waits and deserve different
 * words: during the first there is nothing to show but elapsed time, during
 * the second the throughput is the interesting number.
 */
function formatStreamProgress(
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

function formatDuration(elapsedMs: number): string {
  const seconds = elapsedMs / 1000;
  if (seconds < 10) {
    return `${seconds.toFixed(1)}s`;
  }

  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }

  return `${Math.floor(seconds / 60)}m${String(Math.round(seconds % 60)).padStart(2, "0")}s`;
}

/**
 * Status events (the capability probe, repair nudges, pruning) are the
 * harness talking to itself. They drive the run line while they matter and
 * stay out of scrollback unless PATCHPILOT_DEBUG is set. Todo updates already
 * show in the plan dock, so their tool entry would say the same thing twice.
 */
export function describeApproval(tool: AgentEventToolName, decision: PermissionDecision): string {
  const verb = toolVerb(tool);
  return decision === "deny" ? `Denied ${verb}` : decision === "allow_session" ? `Allowed ${verb} for this session` : `Allowed ${verb} once`;
}

export function belongsInTranscript(event: AgentEvent, debug = Boolean(process.env.PATCHPILOT_DEBUG && process.env.PATCHPILOT_DEBUG !== "0")): boolean {
  if (debug) {
    return true;
  }
  if (event.type === "status" || event.type === "subagent") {
    return false;
  }
  return !(event.type === "tool" && event.name === "update_todo");
}

export function eventToLine(event: AgentEvent): LogLineInput {
  switch (event.type) {
    case "subagent":
      return { kind: "status", tone: "muted", label: "subagent", text: `${event.agentType} agent ${event.state}: ${event.description}`, workState: event.workState };
    case "compacted":
      return {
        kind: "status",
        tone: "muted",
        label: "compacted",
        text: `Compacted conversation (${formatCompactTokens(event.beforeTokens)} → ${formatCompactTokens(event.afterTokens)} tokens)`,
        workState: event.workState
      };
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
      if (event.metadata?.background === true) {
        return backgroundTaskLine(event);
      }
      const subagentType = typeof event.metadata?.subagent === "string" ? event.metadata.subagent : null;
      if (subagentType) {
        const calls = Number(event.metadata?.toolCalls ?? 0);
        const seconds = Math.round(Number(event.metadata?.durationMs ?? 0) / 1000);
        const incomplete = event.metadata?.status === "incomplete";
        const stopped = event.metadata?.status === "aborted";
        return {
          kind: "tool",
          tone: event.ok && !incomplete ? "success" : "warning",
          label: subagentType === "explore" ? "Explore" : "Agent",
          text: `${stopped ? "Stopped" : incomplete ? "Step limit reached" : event.ok ? "Done" : "Failed"} · ${calls === 1 ? "1 tool call" : `${calls} tool calls`} · ${seconds}s`,
          detail: stopped ? undefined : typeof event.metadata?.summary === "string" ? event.metadata.summary : event.content,
          workState: event.workState,
          toolCallId: event.toolCallId,
          category: "state",
          agent: true,
          target: typeof event.metadata?.description === "string" ? event.metadata.description : undefined
        };
      }
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
        preview: event.preview,
        target: describeToolTarget(event.arguments),
        ...(event.ok && typeof event.metadata?.diff === "string" && event.metadata.diff ? { diff: event.metadata.diff } : {})
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
        text: describeApproval(event.request.tool, event.decision),
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

function backgroundTaskLine(event: Extract<AgentEvent, { type: "tool" }>): LogLineInput {
  const agent = typeof event.metadata?.agent === "string" ? event.metadata.agent : undefined;
  const shared = { kind: "tool" as const, tone: event.ok ? ("success" as const) : ("warning" as const), workState: event.workState, toolCallId: event.toolCallId, category: "state" as const, detail: event.ok ? undefined : event.content };
  switch (event.metadata?.action) {
    case "start":
      return {
        ...shared,
        label: event.arguments?.subagent_type === "general" ? "Agent" : "Explore",
        target: describeToolTarget(event.arguments),
        text: event.ok ? `Running in the background · ${agent ?? ""}` : event.summary
      };
    case "message":
      return { ...shared, label: "Message", target: agent, text: event.summary };
    case "stop":
      return { ...shared, label: "Stop", target: agent, text: event.summary };
    default:
      return { ...shared, label: "Status", target: agent, text: event.summary };
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

  if (event.type === "subagent") {
    return `${event.agentType} agent: ${event.description}`;
  }

  if (event.type === "tool") {
    return `${event.name}: ${event.summary}`;
  }

  if (event.type === "todo") {
    return event.summary;
  }

  if (event.type === "approval") {
    return describeApproval(event.request.tool, event.decision);
  }

  return event.type;
}
