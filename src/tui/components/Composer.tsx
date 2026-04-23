import React from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";

export function Composer(props: {
  input: string;
  isRunning: boolean;
  draftTokens: number;
  mask?: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
}): React.ReactElement {
  return (
    <Box marginTop={1} flexDirection="column">
      <Box>
        <Text color={props.isRunning ? "yellow" : "cyan"}>{props.isRunning ? "running  " : "patch >  "}</Text>
        {props.isRunning ? (
          <Text color="gray">waiting for model or tool result...</Text>
        ) : (
          <TextInput value={props.input} onChange={props.onChange} onSubmit={props.onSubmit} placeholder="Ask PatchPilot or type /help..." mask={props.mask} />
        )}
      </Box>
      {!props.isRunning ? <Text color="gray">prompt {props.draftTokens} tok est</Text> : null}
    </Box>
  );
}

export function FooterHints(props: { activePane: "transcript" | "session" }): React.ReactElement {
  return (
    <Box marginTop={1}>
      <Text color="gray">
        tab mode  |  pane {props.activePane}  |  left/right pane  |  pgup/pgdn scroll  |  /help commands
      </Text>
    </Box>
  );
}
