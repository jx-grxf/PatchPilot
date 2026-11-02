import { Box, Text } from "ink";
import React from "react";
import type { ChildAgentSnapshot } from "../../core/agentSupervisor.js";
import { agentDisplayName, describeAgentActivity, formatAgentFigures, isAgentActive, windowAgents } from "../agentView.js";
import { symbols } from "./theme.js";

/**
 * Running subagents as a tree: one row per child with the call it is on, so a minute of delegation does not look like a hang.
 */
export function AgentsDock(props: { agents: ChildAgentSnapshot[]; width: number }): React.ReactElement {
  const running = props.agents.filter((agent) => isAgentActive(agent.state)).length;
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
              <Text bold>{agentDisplayName(agent)}</Text>
              <Text color="gray"> ({agent.description})</Text>
            </Text>
            <Text wrap="truncate" color="gray">
              {last ? "     " : "  │  "}
              {symbols.result} {describeAgentActivity(agent)}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

export type MainAgentRow = {
  activity: string;
  active: boolean;
  durationMs: number;
  promptTokens: number;
  outputTokens: number;
};

/** The agents you can look into, under the status bar. The arrows pick; the transcript above follows the pick. */
export function AgentList(props: {
  agents: ChildAgentSnapshot[];
  selected: string | null;
  main: MainAgentRow;
  width: number;
}): React.ReactElement {
  const { visible, hiddenAbove, hiddenBelow } = windowAgents(props.agents, props.selected);
  const nameWidth = Math.max(4, ...visible.map((agent) => agentDisplayName(agent).length));
  const viewed = props.agents.find((agent) => agent.id === props.selected);
  const hint = [
    "↑/↓ to select",
    viewed ? (isAgentActive(viewed.state) ? "esc stops this agent" : "esc back to main") : "",
    props.agents.some((agent) => isAgentActive(agent.state)) ? "ctrl+x ctrl+k stops all agents" : ""
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Box flexDirection="column" paddingX={1} width={props.width}>
      <Text color="gray" wrap="truncate">
        {hint}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <AgentRow
          selected={props.selected === null}
          name="main"
          nameWidth={nameWidth}
          description=""
          activity={props.main.activity}
          figures={props.main.durationMs > 0 ? formatAgentFigures(props.main, props.width) : ""}
          tone={props.main.active ? "active" : "quiet"}
        />
        {hiddenAbove > 0 ? <MoreRow count={hiddenAbove} direction="above" /> : null}
        {visible.map((agent) => (
          <AgentRow
            key={agent.id}
            selected={props.selected === agent.id}
            name={agentDisplayName(agent)}
            nameWidth={nameWidth}
            description={agent.description}
            activity={describeAgentActivity(agent)}
            figures={formatAgentFigures(agent, props.width)}
            tone={agent.state === "failed" ? "failed" : agent.state === "incomplete" ? "partial" : isAgentActive(agent.state) ? "active" : "quiet"}
          />
        ))}
        {hiddenBelow > 0 ? <MoreRow count={hiddenBelow} direction="below" /> : null}
      </Box>
    </Box>
  );
}

function MoreRow(props: { count: number; direction: "above" | "below" }): React.ReactElement {
  return (
    <Text color="gray" wrap="truncate">
      {"    "}… {props.count} more {props.direction}
    </Text>
  );
}

function AgentRow(props: {
  selected: boolean;
  name: string;
  nameWidth: number;
  description: string;
  activity: string;
  figures: string;
  tone: "active" | "quiet" | "failed" | "partial";
}): React.ReactElement {
  const activityColor = props.tone === "failed" ? "red" : props.tone === "partial" ? "yellow" : props.tone === "active" && !props.selected ? "white" : "gray";
  return (
    <Box justifyContent="space-between">
      <Box flexShrink={1} flexGrow={1}>
        <Text wrap="truncate" bold={props.selected}>
          <Text>{props.selected ? "❯ " : "  "}</Text>
          <Text color={props.selected ? "white" : "gray"}>{props.selected ? "● " : "○ "}</Text>
          <Text color={props.selected ? "white" : undefined}>{props.name.padEnd(props.nameWidth)}</Text>
          {props.description ? <Text color="gray">  {props.description}</Text> : null}
          <Text color={activityColor}>  {props.activity}</Text>
        </Text>
      </Box>
      {props.figures ? (
        <Box flexShrink={0} marginLeft={2}>
          <Text color={props.selected ? "white" : "gray"} bold={props.selected}>
            {props.figures}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
