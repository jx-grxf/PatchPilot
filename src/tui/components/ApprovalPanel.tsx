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
    <Box borderStyle="double" borderColor="yellow" flexDirection="column" paddingX={1} marginTop={1} height={5} overflowY="hidden">
      <Text color="yellow" bold>
        ACTION REQUIRED  {request.tool} needs {request.permission}
      </Text>
      <Text color="white" bold wrap="truncate">
        {request.preview}
      </Text>
      <Text color="cyan" bold>Press [y] allow once  [a] allow session  [n/Esc] deny</Text>
    </Box>
  );
}
