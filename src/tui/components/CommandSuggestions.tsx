import React from "react";
import { Box, Text } from "ink";

export type CommandSuggestionItem = {
  key: string;
  category: string;
  label: string;
  detail: string;
  hint?: string;
};

export function CommandSuggestions(props: {
  items: CommandSuggestionItem[];
  selectedIndex: number;
}): React.ReactElement | null {
  if (props.items.length === 0) {
    return null;
  }

  return (
    <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1} marginTop={1}>
      <Text color="cyan" bold>
        Command palette
      </Text>
      <Text color="gray">Use up/down to pick, Enter to apply, Escape to clear.</Text>
      {props.items.slice(0, 8).map((item, index) => {
        const isSelected = index === props.selectedIndex;
        return (
          <Box key={item.key} marginTop={index === 0 ? 1 : 0}>
            <Box width={2}>
              <Text color={isSelected ? "cyan" : "gray"}>{isSelected ? ">" : " "}</Text>
            </Box>
            <Box width={13}>
              <Text color={isSelected ? "cyan" : "gray"} bold={isSelected}>
                {item.category}
              </Text>
            </Box>
            <Box width={32}>
              <Text color={isSelected ? "white" : "cyan"} bold={isSelected} wrap="truncate">
                {item.label}
              </Text>
            </Box>
            <Text color={isSelected ? "white" : "gray"} wrap="truncate">
              {item.detail}
              {item.hint ? `  ${item.hint}` : ""}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
