import React from "react";
import { Box, Text } from "ink";

const wordmark = [
  "██████╗  █████╗ ████████╗ ██████╗██╗  ██╗██████╗ ██╗██╗      ██████╗ ████████╗",
  "██╔══██╗██╔══██╗╚══██╔══╝██╔════╝██║  ██║██╔══██╗██║██║     ██╔═══██╗╚══██╔══╝",
  "██████╔╝███████║   ██║   ██║     ███████║██████╔╝██║██║     ██║   ██║   ██║",
  "██╔═══╝ ██╔══██║   ██║   ██║     ██╔══██║██╔═══╝ ██║██║     ██║   ██║   ██║",
  "██║     ██║  ██║   ██║   ╚██████╗██║  ██║██║     ██║███████╗╚██████╔╝   ██║",
  "╚═╝     ╚═╝  ╚═╝   ╚═╝    ╚═════╝╚═╝  ╚═╝╚═╝     ╚═╝╚══════╝ ╚═════╝    ╚═╝",
];

const wordmarkWidth = Math.max(...wordmark.map((line) => line.length));

// Small robot + wrench, kept compact so it clips gracefully on narrow terminals.
const robot = [
  "  ╭───────╮",
  "  │ ◠   ◠ │  ⚡",
  "  │   ▿   │ ╱",
  "  ╰──┬─┬──╯╱",
  "  ┌──┴─┴──┐",
];

/**
 * Claude-Code-style welcome banner for the experimental shell. Renders the
 * full PATCHPILOT wordmark when there is room, and degrades responsively to a
 * compact heading on narrow terminals instead of forcing a clipped block.
 */
export function ExperimentalBanner(props: { width: number; height: number }): React.ReactElement {
  const showWordmark = props.width >= wordmarkWidth + 2 && props.height >= 12;
  const showRobot = props.width >= wordmarkWidth + 16 && props.height >= 14;

  if (!showWordmark) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color="cyan" bold>
          ▸ PatchPilot <Text color="gray">— terminal shell</Text>
        </Text>
        <Text color="gray">Local-only coding agent. Visible tools, explicit permissions.</Text>
        <Text color="gray">Type a task, or press / for the command palette.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="row">
        <Box flexDirection="column">
          {wordmark.map((line, index) => (
            <Text key={`wm-${index}`} color="cyan" bold>
              {line}
            </Text>
          ))}
        </Box>
        {showRobot ? (
          <Box flexDirection="column" marginLeft={2}>
            {robot.map((line, index) => (
              <Text key={`bot-${index}`} color={index === 1 ? "cyan" : "gray"}>
                {line}
              </Text>
            ))}
          </Box>
        ) : null}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color="white" bold>
          Welcome to PatchPilot.
        </Text>
        <Text color="gray">
          Local-only inference — every read, write, command, and model route stays visible.
        </Text>
        <Text color="gray">
          <Text color="cyan">/</Text> command palette <Text color="gray">·</Text>{" "}
          <Text color="cyan">tab</Text> plan / build / bypass <Text color="gray">·</Text>{" "}
          <Text color="cyan">/help</Text> for everything
        </Text>
      </Box>
    </Box>
  );
}
