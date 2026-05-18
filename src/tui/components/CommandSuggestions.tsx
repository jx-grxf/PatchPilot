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

  const maxRows = 8;
  const startIndex = Math.max(0, Math.min(props.selectedIndex - Math.floor(maxRows / 2), Math.max(0, props.items.length - maxRows)));
  const visibleItems = props.items.slice(startIndex, startIndex + maxRows);
  const endIndex = startIndex + visibleItems.length;

  return (
    <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1} height={Math.min(maxRows, props.items.length) + 4} overflowY="hidden">
      <Text color="gray">
        Use up/down to pick, Enter to apply, Escape to clear. {startIndex + 1}-{endIndex}/{props.items.length}
      </Text>
      {visibleItems.map((item, index) => {
        const absoluteIndex = startIndex + index;
        const isSelected = absoluteIndex === props.selectedIndex;
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
