import React from "react";
import { Box, Text } from "ink";

export type ExperimentalFlag = "fileAnalysis" | "memory" | "subagents" | "shellMetacharacters";

export type ExperimentalFlags = Record<ExperimentalFlag, boolean>;

const experimentalRows: Array<{
  key: ExperimentalFlag;
  label: string;
  description: string;
}> = [
  {
    key: "fileAnalysis",
    label: "File Analysis",
    description: "Allow image, PDF, DOCX, Markdown, and external-file inspection once provider plumbing is available."
  },
  {
    key: "memory",
    label: "Memory",
    description: "Enable the upcoming SQLite/vector memory layer for durable project/user notes."
  },
  {
    key: "subagents",
    label: "Subagents",
    description: "Enable explorer, planner, and reviewer advisors for larger workspace tasks."
  },
  {
    key: "shellMetacharacters",
    label: "Shell Metachars",
    description: "Allow pipes, &&, and ; in run_shell. Redirects and expansion still ask even in bypass."
  }
];

export function ExperimentalPanel(props: {
  flags: ExperimentalFlags;
  selectedIndex: number;
  height: number;
}): React.ReactElement {
  return (
    <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={2} height={props.height} overflowY="hidden">
      <Text color="cyan" bold>
        PatchPilot Experimental
      </Text>
      <Text color="white">Use up/down to move, Space to toggle, Enter or Escape to close.</Text>
      <Box flexDirection="column" marginTop={2}>
        {experimentalRows.map((row, index) => {
          const selected = index === props.selectedIndex;
          const enabled = props.flags[row.key];
          return (
            <Box key={row.key} marginTop={index === 0 ? 0 : 1}>
              <Box width={3}>
                <Text color={selected ? "cyan" : "gray"}>{selected ? ">" : " "}</Text>
              </Box>
              <Box width={5}>
                <Text color={enabled ? "green" : "gray"}>{enabled ? "[x]" : "[ ]"}</Text>
              </Box>
              <Box width={18}>
                <Text color={selected ? "white" : "cyan"} bold={selected}>
                  {row.label}
                </Text>
              </Box>
              <Text color={selected ? "white" : "gray"}>{row.description}</Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

export function experimentalFlagAt(index: number): ExperimentalFlag {
  return experimentalRows[Math.max(0, Math.min(index, experimentalRows.length - 1))]?.key ?? "fileAnalysis";
}

export function experimentalFlagCount(): number {
  return experimentalRows.length;
}
