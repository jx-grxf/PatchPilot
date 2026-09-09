import React from "react";
import { Box, Static, Text } from "ink";
import { ExperimentalBanner } from "./Banner.js";
import { DiffBlock, Markdown } from "../components/Markdown.js";
import { symbols } from "./theme.js";
import type { LogLine } from "../types.js";

/**
 * The scrollback shell.
 *
 * Both earlier shells were fixed-viewport pagers: a bordered box of constant
 * height with `overflowY="hidden"`, whose visible slice was computed by hand
 * from a scroll offset. That is why history had to be capped, why paging
 * needed its own key bindings, and why the terminal's own scrollback stayed
 * empty.
 *
 * This renders history through Ink's `<Static>` instead. Ink prints those rows
 * once, above the live frame, so they land in the terminal's real scrollback —
 * which means the terminal handles wheel scrolling, selection and copy, and
 * none of that has to be reimplemented. Only the footer re-renders.
 *
 * Two constraints follow from `<Static>` and both are load-bearing:
 *
 *   1. Items are rendered once and never revisited, so a row must be complete
 *      before it is appended. Nothing here may depend on later state.
 *   2. Clearing the transcript cannot un-print what the terminal already has.
 *      `/clear` remounts this component with a new epoch key, which starts a
 *      fresh Static region rather than pretending the old rows are gone.
 */

export type FlowShellProps = {
  lines: LogLine[];
  /** Bumped by /clear and /new to start a fresh static region. */
  transcriptEpoch: number;
  columns: number;
  /** Print the wordmark once, ahead of the first entry. */
  showBanner?: boolean;
};

/**
 * A sentinel first item so the banner prints once, into scrollback, with the
 * transcript. It cannot be rendered outside `<Static>` — Ink requires Static
 * to be the first child — and rendering it above the live frame would redraw
 * the logo on every keystroke.
 */
const bannerItem = { id: -1, kind: "banner" } as const;

export function FlowShell(props: FlowShellProps): React.ReactElement {
  const items: Array<LogLine | typeof bannerItem> = props.showBanner ? [bannerItem, ...props.lines] : props.lines;

  return (
    <Static key={props.transcriptEpoch} items={items}>
      {(item) =>
        item.id === -1 ? (
          <Box key="banner" flexDirection="column" marginBottom={1}>
            <ExperimentalBanner width={props.columns} height={14} />
          </Box>
        ) : (
          <TranscriptEntry key={item.id} line={item as LogLine} columns={props.columns} />
        )
      }
    </Static>
  );
}

/**
 * One completed transcript entry. Rendered exactly once, so it carries its own
 * spacing rather than relying on a parent to lay entries out relative to one
 * another.
 */
function TranscriptEntry(props: { line: LogLine; columns: number }): React.ReactElement {
  const { line } = props;

  switch (line.kind) {
    case "user":
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text color="cyan" bold>
              {symbols.user}{" "}
            </Text>
            <Text color="white">{line.text}</Text>
          </Text>
        </Box>
      );

    case "assistant":
    case "final":
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color={line.kind === "final" ? "green" : "cyan"} bold>
            {line.kind === "final" ? symbols.final : symbols.assistant} {line.label}
          </Text>
          <Box paddingLeft={2} flexDirection="column">
            <Markdown text={line.text} width={props.columns - 4} />
            {line.detail ? <Markdown text={line.detail} width={props.columns - 4} dim /> : null}
          </Box>
        </Box>
      );

    case "thinking":
      // Reasoning is context for the answer, not the answer. It stays visible
      // but visually subordinate to it.
      return (
        <Box flexDirection="column" marginTop={1} paddingLeft={2}>
          <Text color="gray" italic>
            {symbols.thinking} {collapse(line.text, props.columns * 3)}
          </Text>
        </Box>
      );

    case "tool":
      return (
        <Box flexDirection="column">
          <Text>
            <Text color={line.tone === "danger" ? "red" : line.tone === "warning" ? "yellow" : "green"}>
              {symbols.tool}{" "}
            </Text>
            <Text color="white">{line.tool ?? line.label}</Text>
            <Text color="gray"> {collapse(line.text, props.columns - 12)}</Text>
          </Text>
          {line.preview ? (
            <Box paddingLeft={2}>
              <Text color="gray">{collapse(line.preview, props.columns - 4)}</Text>
            </Box>
          ) : null}
        </Box>
      );

    case "diff":
      return (
        <Box flexDirection="column" paddingLeft={2}>
          <DiffBlock lines={line.text.split("\n")} width={props.columns - 4} />
        </Box>
      );

    case "error":
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color="red" bold>
            {symbols.error} {line.label}
          </Text>
          <Box paddingLeft={2} flexDirection="column">
            <Text color="red">{line.text}</Text>
            {line.detail ? <Text color="gray">{line.detail}</Text> : null}
          </Box>
        </Box>
      );

    case "approval":
      return (
        <Text>
          <Text color="yellow">{symbols.approval} </Text>
          <Text color="gray">{line.text}</Text>
        </Text>
      );

    case "status":
      return (
        <Text color="gray">
          {symbols.bullet} {collapse(line.text, props.columns - 4)}
        </Text>
      );
  }
}

/** Collapses whitespace and clips, so one long line cannot wreck the layout. */
function collapse(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  const limit = Math.max(20, maxLength);
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}
