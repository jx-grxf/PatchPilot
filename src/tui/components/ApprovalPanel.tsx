import React from "react";
import { Box, Text } from "ink";
import type { ApprovalRequest } from "../../core/types.js";

export function ApprovalPanel(props: {
  request: ApprovalRequest | null;
  bypassConfirmation: boolean;
}): React.ReactElement | null {
  if (!props.request && !props.bypassConfirmation) {
    return null;
  }

  if (props.bypassConfirmation) {
    return (
    <Box borderStyle="double" borderColor="red" flexDirection="column" paddingX={1} marginTop={1} height={5} overflowY="hidden">
      <Text color="red" bold>
          ACTION REQUIRED  TRUSTED BYPASS
      </Text>
        <Text color="white" bold>Write and shell tools will run without per-tool prompts in this TUI session.</Text>
        <Text color="cyan" bold>Press [y] accept bypass  [n/Esc/Tab] stay approval-gated build</Text>
      </Box>
    );
  }

  const request = props.request;
  if (!request) {
    return null;
  }

  return (
    <Box borderStyle="double" borderColor="yellow" flexDirection="column" paddingX={1} marginTop={1} height={6} overflowY="hidden">
      <Text color="yellow" bold>
        ACTION REQUIRED  {request.tool} needs {request.permission} approval
      </Text>
      <Text color="gray">
        risk {request.risk}  scope allow-session applies only to this tool{request.bypassable === false ? "  bypass cannot skip this" : ""}
      </Text>
      <Text color="white" bold wrap="wrap">
        {request.preview} {formatApprovalTarget(request.arguments)}
      </Text>
      <Text color="cyan" bold>Press [y] allow once  [a] allow session  [n/Esc] deny</Text>
    </Box>
  );
}

function formatApprovalTarget(argumentsValue: Record<string, unknown>): string {
  const pathValue = typeof argumentsValue.path === "string" ? argumentsValue.path : "";
  const commandValue = typeof argumentsValue.command === "string" ? argumentsValue.command : "";
  const scriptValue = typeof argumentsValue.script === "string" ? argumentsValue.script : "";
  if (pathValue) {
    return `target ${pathValue}`;
  }
  if (scriptValue) {
    return `script ${scriptValue}`;
  }
  if (commandValue) {
    return `command ${commandValue}`;
  }
  return "";
}
