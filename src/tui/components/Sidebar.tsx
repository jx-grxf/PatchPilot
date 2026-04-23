import React from "react";
import { Box, Text } from "ink";
import type { ModelProvider, ModelTelemetry, SessionTelemetry } from "../../core/types.js";
import { formatCost, formatOllamaHost, formatSessionTokens, formatTokens, shortenMiddle } from "../format.js";
import type { AgentMode, AdvisorNote } from "../types.js";

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
}): React.ReactElement {
  return (
    <Box width={32} borderStyle="round" borderColor="gray" flexDirection="column" paddingX={1} marginRight={1}>
      <Text color="cyan" bold>
        Session
      </Text>
      <SidebarRow label="provider" value={props.provider} color={props.provider === "ollama" ? "green" : "cyan"} />
      <SidebarRow label="mode" value={props.agentMode} color={props.agentMode === "build" ? "yellow" : "green"} />
      <SidebarRow label="write" value={props.allowWrite ? "on" : "off"} color={props.allowWrite ? "green" : "red"} />
      <SidebarRow label="shell" value={props.allowShell ? "on" : "off"} color={props.allowShell ? "green" : "red"} />
      <SidebarRow label="agents" value={props.subagents ? "on" : "off"} color={props.subagents ? "cyan" : "gray"} />

      <Box marginTop={1} flexDirection="column">
        <Text color="cyan" bold>
          Target
        </Text>
        <Text color="gray" wrap="truncate">
          {props.provider === "ollama" ? shortenMiddle(formatOllamaHost(props.ollamaUrl), 26) : `${props.provider} oauth`}
        </Text>
        <Text color="gray" wrap="truncate">
          {shortenMiddle(props.model, 26)}
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color="cyan" bold>
          Workspace
        </Text>
        <Text color="gray" wrap="wrap">
          {shortenMiddle(props.workspace, 58)}
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color="cyan" bold>
          Telemetry
        </Text>
        <Text color="gray" wrap="wrap">
          draft {props.draftTokens} tok
        </Text>
        <Text color="gray" wrap="wrap">
          {formatTokens(props.telemetry)}
        </Text>
        <Text color="gray" wrap="wrap">
          {formatSessionTokens(props.sessionTelemetry)}
        </Text>
        <Text color="gray" wrap="wrap">
          {formatCost(props.sessionTelemetry.estimatedCostUsd)}
        </Text>
      </Box>

      <AdvisorPanel advisors={props.advisors} />
    </Box>
  );
}

function SidebarRow(props: { label: string; value: string; color: "gray" | "green" | "yellow" | "red" | "cyan" }): React.ReactElement {
  return (
    <Box>
      <Box width={9}>
        <Text color="gray">{props.label}</Text>
      </Box>
      <Text color={props.color}>{props.value}</Text>
    </Box>
  );
}

function AdvisorPanel(props: { advisors: AdvisorNote[] }): React.ReactElement {
  return (
    <Box marginTop={1} flexDirection="column">
      <Text color="cyan" bold>
        Advisors
      </Text>
      {props.advisors.length === 0 ? (
        <Text color="gray">No advisor output yet.</Text>
      ) : (
        props.advisors.map((advisor) => (
          <Box key={advisor.role} flexDirection="column" marginBottom={1}>
            <Text color="yellow">{advisor.role}</Text>
            <Text color="gray" wrap="wrap">
              {advisor.message}
            </Text>
          </Box>
        ))
      )}
    </Box>
  );
}
