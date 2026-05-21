import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { AgentWorkState } from "../../core/types.js";
import { computeComposerLayout, formatWorkingStatus } from "../layout.js";

export function Composer(props: {
  input: string;
  isRunning: boolean;
  isApprovalWaiting?: boolean;
  status: string;
  workState: AgentWorkState;
  draftTokens: number;
  width: number;
  mask?: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
}): React.ReactElement {
  const [frameIndex, setFrameIndex] = useState(0);
  const [runningSince, setRunningSince] = useState<number | null>(null);
  const prompt = props.isApprovalWaiting ? "input > " : props.isRunning ? "run   > " : "patch > ";
  const layout = computeComposerLayout({
    input: props.input,
    width: props.width,
    promptWidth: prompt.length
  });

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

  useInput(
    (inputValue, key) => {
      if (props.isRunning || props.isApprovalWaiting) {
        return;
      }

      if (key.return) {
        if (key.shift || key.meta || key.super) {
          props.onChange(`${props.input}\n`);
          return;
        }

        props.onSubmit(props.input);
        return;
      }

      if (key.backspace || key.delete) {
        props.onChange(props.input.slice(0, -1));
        return;
      }

      if (key.tab || key.escape || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.pageUp || key.pageDown || key.home || key.end) {
        return;
      }

      if (key.ctrl || inputValue.length === 0) {
        return;
      }

      props.onChange(`${props.input}${inputValue}`);
    },
    {
      isActive: !props.isRunning && !props.isApprovalWaiting
    }
  );

  const elapsedSeconds = runningSince ? Math.max(0, Math.floor((Date.now() - runningSince) / 1000)) : 0;
  const verbIndex = Math.floor(elapsedSeconds / 10);
  const renderedRows = props.mask ? layout.visibleRows.map((row) => props.mask?.repeat(row.length) ?? row) : layout.visibleRows;
  const placeholder = props.input.length === 0 ? "Ask PatchPilot or type /help..." : "";

  return (
    <Box flexDirection="column" height={layout.height} overflowY="hidden">
      <Box height={layout.editorRows} flexDirection="column">
        {props.isApprovalWaiting || props.isRunning ? (
          <Box height={1}>
            <Text color={props.isApprovalWaiting ? "yellow" : "cyan"}>{prompt}</Text>
            {props.isApprovalWaiting ? (
              <Text color="yellow">approval waiting</Text>
            ) : (
              <Text color="yellow">
                {spinnerFrames[frameIndex]} {formatWorkingStatus(props.workState, verbIndex, props.status)}
                <Text color="gray">{elapsedSeconds > 0 ? `  ${elapsedSeconds}s` : "  starting"}</Text>
              </Text>
            )}
          </Box>
        ) : renderedRows.map((row, index) => {
          const isLastRow = index === renderedRows.length - 1;
          const text = row || (isLastRow ? placeholder : "");
          return (
            <Box key={`composer-row-${index}`} height={1}>
              <Text color="cyan">{index === 0 ? prompt : " ".repeat(prompt.length)}</Text>
              <Text color={placeholder && isLastRow ? "gray" : "white"}>
                {text}
                {isLastRow ? <Text inverse> </Text> : null}
              </Text>
            </Box>
          );
        })}
      </Box>
      <Text color="gray" wrap="truncate">
        {props.isApprovalWaiting ? "Approval waiting: press y once, a session, or n deny." : props.isRunning ? "Input is locked while the current run is active." : `prompt ${props.draftTokens} tok est${layout.hiddenRows > 0 ? `  ${layout.hiddenRows} earlier draft line${layout.hiddenRows === 1 ? "" : "s"}` : ""}  Enter sends  Shift/Meta+Enter newline`}
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

const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
