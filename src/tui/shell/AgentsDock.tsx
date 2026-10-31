import { Box, Text } from "ink";
import React from "react";
import type { AgentEvent } from "../../core/types.js";
import { describeToolTarget, toolVerb } from "../toolDisplay.js";
import { symbols } from "./theme.js";

export type SubagentProgress = Extract<AgentEvent, { type: "subagent" }>;

/**
 * Running subagents as a tree: one row per child with the call it is on, so a minute of delegation does not look like a hang.
 */
export function AgentsDock(props: { agents: SubagentProgress[]; width: number }): React.ReactElement {
  const running = props.agents.filter((agent) => agent.state === "running").length;
  const heading = running > 0 ? `${running} ${running === 1 ? "agent" : "agents"} running` : `${props.agents.length} ${props.agents.length === 1 ? "agent" : "agents"} finished`;

  return (
    <Box flexDirection="column" marginTop={1} width={props.width}>
      <Text>
        <Text color={running > 0 ? "cyan" : "green"}>{symbols.tool} </Text>
        <Text bold>{heading}</Text>
      </Text>
      {props.agents.map((agent, index) => {
        const last = index === props.agents.length - 1;
        return (
          <Box key={agent.id} flexDirection="column">
            <Text wrap="truncate">
              <Text color="gray">{last ? "  └─ " : "  ├─ "}</Text>
              <Text bold>{agent.agentType === "explore" ? "Explore" : "Agent"}</Text>
              <Text color="gray"> ({agent.description})</Text>
            </Text>
            <Text wrap="truncate" color="gray">
              {last ? "     " : "  │  "}
              {symbols.result} {describeProgress(agent)}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

function describeProgress(agent: SubagentProgress): string {
  const calls = agent.toolCalls === 1 ? "1 tool call" : `${agent.toolCalls} tool calls`;
  if (agent.state === "ok") {
    return `Done · ${calls}`;
  }
  if (agent.state === "failed") {
    return `Failed · ${calls}`;
  }
  if (agent.state === "aborted") {
    return "Stopped";
  }
  if (!agent.activity) {
    return "Starting…";
  }
  const target = describeToolTarget(agent.activity.arguments, 60);
  return `${toolVerb(agent.activity.name)}${target ? `(${target})` : ""} · ${calls}`;
}
