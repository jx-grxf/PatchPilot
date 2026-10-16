import React from "react";
import { Box, Text } from "ink";
import { symbols } from "./theme.js";

export type CommandSuggestionItem = {
  key: string;
  category: string;
  label: string;
  detail: string;
  hint?: string;
};

const MAX_VISIBLE = 8;

/**
 * Matching commands under the composer; the highlighted one runs on ⏎.
 *
 * The list always takes the same number of rows while it is open. Filtering
 * changes how many commands match on every keystroke, and a list that grows
 * and shrinks makes the composer above it jump with each letter.
 */
export function CommandPalette(props: { items: CommandSuggestionItem[]; selectedIndex: number; query: string }): React.ReactElement | null {
  if (props.items.length === 0) {
    return null;
  }

  const selectedIndex = Math.max(0, Math.min(props.selectedIndex, props.items.length - 1));
  const startIndex = Math.max(0, Math.min(selectedIndex - Math.floor(MAX_VISIBLE / 2), Math.max(0, props.items.length - MAX_VISIBLE)));
  const visibleItems = props.items.slice(startIndex, startIndex + MAX_VISIBLE);
  const labelWidth = Math.min(26, Math.max(14, ...props.items.map((item) => item.label.length + 3)));
  const needle = props.query.trim().replace(/^\//, "").split(/\s+/)[0]?.toLowerCase() ?? "";
  const padding = MAX_VISIBLE - visibleItems.length;

  return (
    <Box flexDirection="column" paddingX={1}>
      {visibleItems.map((item, index) => {
        const isSelected = startIndex + index === selectedIndex;
        return (
          <Box key={item.key}>
            <Box width={2} flexShrink={0}>
              <Text color="cyan">{isSelected ? symbols.todoActive : " "}</Text>
            </Box>
            <Box width={labelWidth} flexShrink={0}>
              <HighlightedLabel label={item.label} needle={needle} selected={isSelected} />
            </Box>
            <Text color={isSelected ? "white" : "gray"} wrap="truncate">
              {item.detail}
            </Text>
          </Box>
        );
      })}
      {Array.from({ length: padding }, (_, index) => (
        <Text key={`pad-${index}`}> </Text>
      ))}
      <Text color="gray">
        {"  "}
        {props.items.length > MAX_VISIBLE ? `${selectedIndex + 1}/${props.items.length} ${symbols.bullet} ` : ""}↑↓ choose {symbols.bullet} ⏎ run {symbols.bullet} esc close
      </Text>
    </Box>
  );
}

/** The typed characters stand out inside each match, so the filter explains itself. */
function HighlightedLabel(props: { label: string; needle: string; selected: boolean }): React.ReactElement {
  const at = props.needle ? props.label.toLowerCase().indexOf(props.needle) : -1;
  const base = props.selected ? "cyan" : "white";
  if (at < 0) {
    return (
      <Text color={base} bold={props.selected} wrap="truncate">
        {props.label}
      </Text>
    );
  }

  const end = at + props.needle.length;
  return (
    <Text color={base} bold={props.selected} wrap="truncate">
      {props.label.slice(0, at)}
      <Text color="cyan" bold underline>
        {props.label.slice(at, end)}
      </Text>
      {props.label.slice(end)}
    </Text>
  );
}
