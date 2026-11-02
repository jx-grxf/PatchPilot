import { useEffect, useState } from "react";
import type { AgentSupervisor, ChildAgentSnapshot } from "../core/agentSupervisor.js";
import { stripTerminalControls } from "./format.js";

/** Stream progress notifies on every token; the screen does not need all of them. */
const renderIntervalMs = 120;

/** The durations in the list keep counting between events. */
const tickIntervalMs = 1000;

/** Model output, which may carry whatever a file it read contained, goes straight to the screen from here. */
function displayable(agents: ChildAgentSnapshot[]): ChildAgentSnapshot[] {
  return agents.map((agent) => ({
    ...agent,
    description: stripTerminalControls(agent.description),
    streaming: agent.streaming ? { ...agent.streaming, content: stripTerminalControls(agent.streaming.content) } : null
  }));
}

export function useAgents(supervisor: AgentSupervisor): ChildAgentSnapshot[] {
  const [agents, setAgents] = useState<ChildAgentSnapshot[]>(() => displayable(supervisor.list()));

  useEffect(() => {
    let pending: NodeJS.Timeout | null = null;
    const unsubscribe = supervisor.subscribe(() => {
      pending ??= setTimeout(() => {
        pending = null;
        setAgents(displayable(supervisor.list()));
      }, renderIntervalMs);
    });
    const ticker = setInterval(() => {
      if (supervisor.hasActive()) {
        setAgents(displayable(supervisor.list()));
      }
    }, tickIntervalMs);
    setAgents(displayable(supervisor.list()));
    return () => {
      unsubscribe();
      clearInterval(ticker);
      if (pending) {
        clearTimeout(pending);
      }
    };
  }, [supervisor]);

  return agents;
}
