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
  const selectedItem = props.items[props.selectedIndex] ?? props.items[0];
  const hasPreview = Boolean(selectedItem);

  return (
    <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1} height={Math.min(maxRows, props.items.length) + (hasPreview ? 7 : 4)} overflowY="hidden">
      <Text color="gray">
        Command palette  use up/down to pick, Enter to select, Escape to clear. {startIndex + 1}-{endIndex}/{props.items.length}
      </Text>
      <Box marginTop={1}>
        <Text color="cyan" bold>Commands</Text>
        <Text color="gray"> grouped by category</Text>
      </Box>
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
                {formatCategory(item.category)}
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
      {selectedItem ? (
        <Box marginTop={1} borderStyle="single" borderColor="gray" paddingX={1} flexDirection="column">
          <Text color="cyan" bold>{selectedItem.label}</Text>
          <Text color="white" wrap="truncate">{selectedItem.detail}</Text>
          <Text color="gray" wrap="truncate">{selectedItem.hint ?? previewForCommand(selectedItem)}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function formatCategory(category: string): string {
  return category.length > 11 ? category.slice(0, 11) : category;
}

function previewForCommand(item: CommandSuggestionItem): string {
  if (item.label.startsWith("/models") || item.label.startsWith("/model")) {
    return "Preview: load provider models, filter by query, then select.";
  }

  if (item.label.startsWith("/sessions") || item.label.startsWith("/resume")) {
    return "Preview: inspect saved workspace session history.";
  }

  if (item.label.startsWith("/connect") || item.label.startsWith("/hosts")) {
    return "Preview: choose local, LAN, Tailscale, or manual Ollama host.";
  }

  if (item.label.startsWith("/doctor")) {
    return "Preview: check runtime, git, provider auth, and bridge setup.";
  }

  if (item.label.startsWith("/experimental")) {
    return "Preview: toggle file analysis, memory, and subagent features.";
  }

  return `Preview: ${item.category} command`;
}
