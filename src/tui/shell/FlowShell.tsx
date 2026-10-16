import React from "react";
import { Box, Static, Text } from "ink";
import { Banner, type BannerInfo } from "./Banner.js";
import { DiffBlock, Markdown } from "../components/Markdown.js";
import { symbols } from "./theme.js";
import { formatToolHeading } from "../toolDisplay.js";
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
  /** Printed once, ahead of the first entry. */
  banner?: BannerInfo;
};

/**
 * A sentinel first item so the banner prints once, into scrollback, with the
 * transcript. It cannot be rendered outside `<Static>` — Ink requires Static
 * to be the first child — and rendering it above the live frame would redraw
 * it on every keystroke.
 */
type BannerItem = { id: -1; banner: BannerInfo };

export function FlowShell(props: FlowShellProps): React.ReactElement {
  // Captured on first render: Static never revisits an item, so the banner
  // shows the session as it was launched.
  const [bannerItem] = React.useState<BannerItem | null>(() => (props.banner ? { id: -1, banner: props.banner } : null));
  const items: Array<LogLine | BannerItem> = bannerItem && props.transcriptEpoch === 0 ? [bannerItem, ...props.lines] : props.lines;

  return (
    <Static key={props.transcriptEpoch} items={items}>
      {(item) =>
        item.id === -1 ? (
          <Banner key="banner" {...(item as BannerItem).banner} />
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
  const bodyWidth = props.columns - 4;

  switch (line.kind) {
    case "user":
      return (
        <Box marginTop={1}>
          <Box width={2} flexShrink={0}>
            <Text color="gray">{symbols.user}</Text>
          </Box>
          <Text color="white">{line.text}</Text>
        </Box>
      );

    case "assistant":
    case "final":
      return (
        <Box marginTop={1}>
          <Box width={2} flexShrink={0}>
            <Text color={line.workState === "error" ? "yellow" : "white"}>{symbols.assistant}</Text>
          </Box>
          <Box flexDirection="column" flexGrow={1}>
            <Markdown text={line.text} width={bodyWidth} />
            {line.detail ? <Markdown text={line.detail} width={bodyWidth} dim /> : null}
          </Box>
        </Box>
      );

    case "thinking":
      // Reasoning is context for the answer, not the answer. It stays visible
      // but visually subordinate to it.
      return (
        <Box marginTop={1}>
          <Box width={2} flexShrink={0}>
            <Text color="gray">{symbols.thinking}</Text>
          </Box>
          <Text color="gray" italic>
            {collapse(line.text, props.columns * 3)}
          </Text>
        </Box>
      );

    case "tool": {
      const failed = line.tone === "danger" || line.tone === "warning";
      const failure = failed && line.detail ? firstLines(line.detail, 3, bodyWidth - 4) : null;
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text wrap="truncate">
            <Text color={failed ? "red" : "green"}>{symbols.tool} </Text>
            <Text bold>{formatToolHeading(line.tool, line.label, line.target)}</Text>
          </Text>
          <Box paddingLeft={2}>
            <Text color={failed ? "red" : "gray"} wrap="truncate">
              {symbols.result}  {collapse(line.text, bodyWidth - 4)}
            </Text>
          </Box>
          {failure ? (
            <Box paddingLeft={5}>
              <Text color="gray">{failure}</Text>
            </Box>
          ) : null}
        </Box>
      );
    }

    case "diff":
      return (
        <Box flexDirection="column" paddingLeft={2} marginTop={1}>
          <DiffBlock lines={line.text.split("\n")} width={bodyWidth} />
        </Box>
      );

    case "error":
      return (
        <Box marginTop={1}>
          <Box width={2} flexShrink={0}>
            <Text color="red">{symbols.error}</Text>
          </Box>
          <Box flexDirection="column" flexGrow={1}>
            <Text color="red">{line.text}</Text>
            {line.detail ? <Text color="gray">{line.detail}</Text> : null}
          </Box>
        </Box>
      );

    case "approval":
      return (
        <Box paddingLeft={2}>
          <Text color="gray">
            <Text color="yellow">{symbols.result}  </Text>
            {line.text}
          </Text>
        </Box>
      );

    case "status":
      // The closing line of a run reads like Claude Code's "Cooked for 3m".
      if (line.label === "done" || line.label === "failed" || line.label === "stopped") {
        return (
          <Box marginTop={1}>
            <Text color={line.label === "done" ? "gray" : "yellow"}>✻ {line.text}</Text>
          </Box>
        );
      }
      return (
        <Text color={line.tone === "warning" ? "yellow" : "gray"}>
          {symbols.bullet} {collapse(line.text, props.columns - 4)}
        </Text>
      );
  }
}

function firstLines(value: string, count: number, width: number): string {
  const lines = value.trim().split(/\r?\n/);
  const shown = lines.slice(0, count).map((row) => (row.length <= width ? row : `${row.slice(0, Math.max(10, width) - 1)}…`));
  return lines.length > count ? `${shown.join("\n")}\n… ${lines.length - count} more lines` : shown.join("\n");
}

/** Collapses whitespace and clips, so one long line cannot wreck the layout. */
function collapse(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  const limit = Math.max(20, maxLength);
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}
