import type { ChildAgentSnapshot, ChildAgentState } from "../core/agentSupervisor.js";
import { formatCompactTokens, stripTerminalControls } from "./format.js";
import { describeToolTarget, toolVerb } from "./toolDisplay.js";
import { belongsInTranscript, eventToLine } from "./transcriptEvents.js";
import type { LogLine, LogLineInput } from "./types.js";

/**
 * Erases the screen and the terminal's scrollback, then homes the cursor. A
 * view switch reprints a whole history through `<Static>`; without erasing the
 * scrollback, wheel-scrolling would run from one agent's history into another's.
 */
export const clearTerminalSequence = "\u001b[2J\u001b[3J\u001b[H";

export const maxVisibleAgentRows = 5;

export function agentDisplayName(agent: Pick<ChildAgentSnapshot, "id" | "agentType">): string {
  return `${agent.agentType === "explore" ? "Explore" : "Agent"} ${agentOrdinal(agent.id)}`;
}

function agentOrdinal(id: string): number {
  return Number.parseInt(id.slice(id.lastIndexOf("-") + 1), 10) || 0;
}

export function isAgentActive(state: ChildAgentState): boolean {
  return state === "queued" || state === "running";
}

/** Active first, each group in start order, so a number keeps its relative place. */
export function orderAgents(agents: ChildAgentSnapshot[]): ChildAgentSnapshot[] {
  return [...agents].sort((left, right) => {
    const activeOrder = Number(isAgentActive(right.state)) - Number(isAgentActive(left.state));
    return activeOrder !== 0 ? activeOrder : agentOrdinal(left.id) - agentOrdinal(right.id);
  });
}

function selectableViews(agents: ChildAgentSnapshot[]): Array<string | null> {
  return [null, ...orderAgents(agents).map((agent) => agent.id)];
}

export function moveSelection(agents: ChildAgentSnapshot[], current: string | null, step: -1 | 1): string | null {
  const views = selectableViews(agents);
  const index = Math.max(0, views.indexOf(current));
  return views[Math.max(0, Math.min(views.length - 1, index + step))] ?? null;
}

/** The rows to show, keeping the selected one inside the window. */
export function windowAgents(
  agents: ChildAgentSnapshot[],
  selected: string | null,
  max = maxVisibleAgentRows
): { visible: ChildAgentSnapshot[]; hiddenAbove: number; hiddenBelow: number } {
  const ordered = orderAgents(agents);
  if (ordered.length <= max) {
    return { visible: ordered, hiddenAbove: 0, hiddenBelow: 0 };
  }
  const selectedIndex = ordered.findIndex((agent) => agent.id === selected);
  const start = selectedIndex < 0 ? 0 : Math.max(0, Math.min(selectedIndex - Math.floor(max / 2), ordered.length - max));
  return { visible: ordered.slice(start, start + max), hiddenAbove: start, hiddenBelow: ordered.length - start - max };
}

export function describeAgentActivity(agent: ChildAgentSnapshot): string {
  const calls = agent.toolCalls === 1 ? "1 tool call" : `${agent.toolCalls} tool calls`;
  switch (agent.state) {
    case "queued":
      return "Waiting for a free slot";
    case "ok":
      return `Done · ${calls}`;
    case "incomplete":
      return `Step limit reached · ${calls}`;
    case "failed":
      return `Failed · ${calls}`;
    case "aborted":
      return "Stopped";
    case "running": {
      if (!agent.activity) {
        return agent.streaming?.phase === "generating" ? "Writing" : "Starting…";
      }
      const target = describeToolTarget(agent.activity.arguments, 60);
      return `${toolVerb(agent.activity.name)}${target ? `(${stripTerminalControls(target)})` : ""} · ${calls}`;
    }
  }
}

export function formatAgentDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** Time and tokens for one row. A narrow window keeps time and output, the two that show progress. */
export function formatAgentFigures(figures: { durationMs: number; promptTokens: number; outputTokens: number }, width: number): string {
  const time = formatAgentDuration(figures.durationMs);
  const output = `↓ ${formatCompactTokens(figures.outputTokens)} tokens`;
  return width < 90 ? `${time} · ${output}` : `${time} · ↑ ${formatCompactTokens(figures.promptTokens)} · ${output}`;
}

/**
 * A child's history as transcript lines. Ids are positions: `<Static>` prints
 * by index and the entries only ever grow, so the same entry always maps to the
 * same line. The first line names the agent, so a reprinted view says whose it is.
 */
export function agentTranscriptLines(agent: ChildAgentSnapshot): LogLine[] {
  const lines: LogLine[] = [
    toLogLine(0, { kind: "status", tone: "muted", label: "agent", text: `${agentDisplayName(agent)} · ${agent.description}` })
  ];
  for (const entry of agent.entries) {
    if (entry.type === "user") {
      lines.push(toLogLine(lines.length, { kind: "user", tone: "normal", label: "you", text: entry.text }));
      continue;
    }
    const { event } = entry;
    if (event.type === "metrics" || event.type === "stream" || event.type === "context" || event.type === "todo" || !belongsInTranscript(event)) {
      continue;
    }
    lines.push(toLogLine(lines.length, eventToLine(event)));
  }
  return lines;
}

function toLogLine(id: number, line: LogLineInput): LogLine {
  return {
    ...line,
    id,
    kind: line.kind ?? "status",
    label: stripTerminalControls(line.label),
    text: stripTerminalControls(line.text),
    detail: line.detail === undefined ? undefined : stripTerminalControls(line.detail),
    preview: line.preview === undefined ? undefined : stripTerminalControls(line.preview),
    target: line.target === undefined ? undefined : stripTerminalControls(line.target)
  };
}
