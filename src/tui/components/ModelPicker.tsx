import React from "react";
import { Box, Text } from "ink";
import { symbols } from "../shell/theme.js";

export type ModelPickerState = {
  models: string[];
  query: string;
  index: number;
};

const visibleRows = 8;

/** `/model` without an argument: filter by typing, move with the arrows, enter switches. */
export function ModelPicker(props: {
  current: string;
  matches: string[];
  query: string;
  index: number;
  formatLabel: (model: string) => string;
  formatDescription: (model: string) => string;
}): React.ReactElement {
  const start = Math.max(0, Math.min(props.index - Math.floor(visibleRows / 2), props.matches.length - visibleRows));
  const shown = props.matches.slice(start, start + visibleRows);

  return (
    <Box borderStyle="round" borderColor="gray" flexDirection="column" paddingX={1} marginTop={1}>
      <Text>
        <Text bold>Switch model</Text>
        <Text color="gray">  type to filter {symbols.bullet} ↑↓ move {symbols.bullet} enter switch {symbols.bullet} esc close</Text>
      </Text>
      <Text>
        <Text color="gray">{symbols.user} </Text>
        <Text>{props.query}</Text>
        <Text inverse> </Text>
      </Text>
      {shown.length === 0 ? <Text color="gray">No model matches "{props.query}".</Text> : null}
      {shown.map((model, offset) => {
        const selected = start + offset === props.index;
        const description = props.formatDescription(model).replace(/^[\s·,-]+/, "");
        return (
          <Box key={model}>
            <Box width={2} flexShrink={0}>
              <Text color="cyan">{selected ? symbols.user : " "}</Text>
            </Box>
            <Box width={44} flexShrink={0}>
              <Text color={selected ? "cyan" : "white"} bold={selected} wrap="truncate">
                {props.formatLabel(model)}
              </Text>
            </Box>
            <Text color="gray" wrap="truncate">
              {model === props.current ? `${symbols.todoDone} current${description ? ` ${symbols.bullet} ` : ""}` : ""}
              {description}
            </Text>
          </Box>
        );
      })}
      {props.matches.length > visibleRows ? (
        <Text color="gray">
          {start + 1}–{start + shown.length} of {props.matches.length}
        </Text>
      ) : null}
    </Box>
  );
}
