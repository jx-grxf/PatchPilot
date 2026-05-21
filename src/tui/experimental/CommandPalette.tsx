import React from "react";
import { Box, Text } from "ink";
import type { CommandSuggestionItem } from "../components/CommandSuggestions.js";
import { symbols } from "./theme.js";

const MAX_VISIBLE = 8;

/**
 * Command palette picker for the experimental shell: a real categorized list
 * with a live preview pane for the highlighted entry.
 */
export function CommandPalette(props: {
  items: CommandSuggestionItem[];
  selectedIndex: number;
  width: number;
}): React.ReactElement | null {
  if (props.items.length === 0) {
    return null;
  }

  const selectedIndex = Math.max(0, Math.min(props.selectedIndex, props.items.length - 1));
  const startIndex = Math.max(
    0,
    Math.min(selectedIndex - Math.floor(MAX_VISIBLE / 2), Math.max(0, props.items.length - MAX_VISIBLE)),
  );
  const visibleItems = props.items.slice(startIndex, startIndex + MAX_VISIBLE);
  const selectedItem = props.items[selectedIndex];
  const wide = props.width >= 96;
  const labelWidth = wide ? 22 : 18;

  return (
    <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text color="cyan" bold>
          {symbols.arrow} Command palette
        </Text>
        <Text color="gray">
          {selectedIndex + 1}/{props.items.length} · ↑↓ move · ⏎ apply · esc clear
        </Text>
      </Box>
      <Box flexDirection={wide ? "row" : "column"} marginTop={1}>
        <Box flexDirection="column" width={wide ? Math.floor(props.width * 0.52) : undefined}>
          {visibleItems.map((item, index) => {
            const absoluteIndex = startIndex + index;
            const isSelected = absoluteIndex === selectedIndex;
            return (
              <Box key={item.key}>
                <Box width={2}>
                  <Text color={isSelected ? "cyan" : "gray"}>{isSelected ? symbols.todoActive : " "}</Text>
                </Box>
                <Box width={11}>
                  <Text color="gray" dimColor={!isSelected}>
                    {item.category.slice(0, 10)}
                  </Text>
                </Box>
                <Box width={labelWidth}>
                  <Text color={isSelected ? "white" : "cyan"} bold={isSelected} wrap="truncate">
                    {item.label}
                  </Text>
                </Box>
                {!wide ? (
                  <Text color={isSelected ? "white" : "gray"} dimColor={!isSelected} wrap="truncate">
                    {item.detail}
                  </Text>
                ) : null}
              </Box>
            );
          })}
        </Box>
        {selectedItem ? (
          <Box
            flexDirection="column"
            flexGrow={1}
            marginLeft={wide ? 2 : 0}
            marginTop={wide ? 0 : 1}
            borderStyle="single"
            borderColor="gray"
            paddingX={1}
          >
            <Text color="cyan" bold wrap="truncate">
              {selectedItem.label}
            </Text>
            <Text color="white" wrap="wrap">
              {selectedItem.detail}
            </Text>
            <Text color="gray" wrap="truncate">
              {selectedItem.hint ? `${symbols.bullet} ${selectedItem.hint}` : `${symbols.bullet} ${selectedItem.category}`}
            </Text>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}
