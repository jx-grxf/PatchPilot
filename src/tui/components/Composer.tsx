import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";

export function Composer(props: {
  input: string;
  isRunning: boolean;
  isApprovalWaiting?: boolean;
  status: string;
  draftTokens: number;
  mask?: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
}): React.ReactElement {
  const [frameIndex, setFrameIndex] = useState(0);
  const [runningSince, setRunningSince] = useState<number | null>(null);

  useEffect(() => {
    if (!props.isRunning) {
      setRunningSince(null);
      setFrameIndex(0);
      return;
    }

    setRunningSince((currentValue) => currentValue ?? Date.now());
    const timer = setInterval(() => {
      setFrameIndex((currentValue) => (currentValue + 1) % spinnerFrames.length);
    }, 120);

    return () => {
      clearInterval(timer);
    };
  }, [props.isRunning]);

  const elapsedSeconds = runningSince ? Math.max(0, Math.floor((Date.now() - runningSince) / 1000)) : 0;

  return (
    <Box flexDirection="column" height={2} overflowY="hidden">
      <Box height={1}>
        <Text color={props.isApprovalWaiting ? "yellow" : props.isRunning ? "yellow" : "cyan"}>
          {props.isApprovalWaiting ? "input >  " : props.isRunning ? "running  " : "patch >  "}
        </Text>
        {props.isRunning && !props.isApprovalWaiting ? (
          <Text color="yellow">
            {spinnerFrames[frameIndex]} {props.status}
            <Text color="gray">{elapsedSeconds > 0 ? `  ${elapsedSeconds}s` : "  starting"}</Text>
          </Text>
        ) : (
          <TextInput value={props.input} onChange={props.onChange} onSubmit={props.onSubmit} placeholder="Ask PatchPilot or type /help..." mask={props.mask} />
        )}
      </Box>
      <Text color="gray" wrap="truncate">
        {props.isApprovalWaiting ? "Approval waiting: use y/a/n or /approve session, /deny." : props.isRunning ? "Input is locked while the current run is active." : `prompt ${props.draftTokens} tok est`}
      </Text>
    </Box>
  );
}

export function FooterHints(props: { activePane: "transcript" | "session" }): React.ReactElement {
  return (
    <Box height={1} overflowY="hidden">
      <Text color="gray">
        tab plan/build/bypass  |  pane {props.activePane}  |  left/right pane  |  pgup/pgdn scroll  |  / starts palette
      </Text>
    </Box>
  );
}

const spinnerFrames = ["-", "\\", "|", "/"];
