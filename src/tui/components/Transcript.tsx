import React from "react";
import { Box, Text } from "ink";
import { toneToColor, toneToMarker } from "../format.js";
import type { LogLine } from "../types.js";

export function Transcript(props: { lines: LogLine[]; isRunning: boolean }): React.ReactElement {
  return (
    <Box borderStyle="round" borderColor={props.isRunning ? "cyan" : "gray"} flexDirection="column" paddingX={1} minHeight={18} flexGrow={1}>
      {props.lines.length === 0 ? <EmptyState /> : props.lines.map((line) => <TranscriptLine key={line.id} line={line} />)}
    </Box>
  );
}

function EmptyState(): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text color="gray">No session activity yet.</Text>
      <Text color="gray">Ask for a repo summary, a focused patch, or type /help.</Text>
    </Box>
  );
}

function TranscriptLine(props: { line: LogLine }): React.ReactElement {
  const marker = toneToMarker(props.line.tone);
  const color = toneToColor(props.line.tone);

  return (
    <Box flexDirection="column" marginBottom={props.line.detail ? 1 : 0}>
      <Box>
        <Box width={3}>
          <Text color={color}>{marker}</Text>
        </Box>
        <Box width={13}>
          <Text color={color} bold>
            {props.line.label}
          </Text>
        </Box>
        <Text color={color} wrap="wrap">
          {props.line.text}
        </Text>
      </Box>
      {props.line.detail ? (
        <Box marginLeft={16}>
          <Text color="gray" wrap="wrap">
            {props.line.detail}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
