import React from "react";
import { Box, Text } from "ink";
import { symbols } from "./theme.js";

export type ThemePickerOption = {
  value: "flow" | "new" | "legacy";
  label: string;
  description: string;
};

/** Fullscreen picker for `/theme` — choose the active terminal interface. */
export function ThemePicker(props: {
  options: ThemePickerOption[];
  selectedIndex: number;
  currentValue: "flow" | "new" | "legacy";
  height: number;
}): React.ReactElement {
  return (
    <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={2} height={props.height} overflowY="hidden">
      <Text color="cyan" bold>
        {symbols.assistant} PatchPilot · interface theme
      </Text>
      <Text color="gray">Use ↑↓ to move, ⏎ to apply, esc to close.</Text>
      <Box flexDirection="column" marginTop={1}>
        {props.options.map((option, index) => {
          const selected = index === props.selectedIndex;
          const isCurrent = option.value === props.currentValue;
          return (
            <Box key={option.value} flexDirection="column" marginTop={index === 0 ? 0 : 1}>
              <Box>
                <Box width={3}>
                  <Text color={selected ? "cyan" : "gray"}>{selected ? symbols.todoActive : " "}</Text>
                </Box>
                <Text color={selected ? "white" : "cyan"} bold={selected}>
                  {option.label}
                </Text>
                {isCurrent ? <Text color="green"> · current</Text> : null}
                {option.value === "flow" ? <Text color="gray"> · default</Text> : null}
              </Box>
              <Box marginLeft={3}>
                <Text color={selected ? "white" : "gray"} dimColor={!selected} wrap="wrap">
                  {option.description}
                </Text>
              </Box>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
