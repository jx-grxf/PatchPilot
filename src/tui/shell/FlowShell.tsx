import React from "react";
import { Box, renderToString, Static, Text } from "ink";
import { Banner, type BannerInfo } from "./Banner.js";
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

const measuredRows = new WeakMap<object, { columns: number; rows: number }>();

/**
 * Rows the static region occupies, so the live region can pad itself out and
 * keep the composer on the bottom rows until the transcript fills the screen.
 *
 * Exact heights come from `measureTranscriptRows`, which has to run outside
 * a render. Until an entry is measured its height is overestimated: a live
 * region that is too short only grows downward on the next frame, while one
 * that is too tall pushes content into scrollback for good.
 */
export function estimateTranscriptRows(lines: LogLine[], columns: number, banner: BannerInfo | null): number {
  let rows = banner ? measuredRows.get(banner)?.rows ?? 6 : 0;
  for (const line of lines) {
    const cached = measuredRows.get(line);
    rows += cached && cached.columns === columns ? cached.rows : overestimateRows(line, columns);
    if (rows > 500) {
      break;
    }
  }
  return rows;
}

/**
 * Renders unmeasured entries off-screen and caches their height. Must not run
 * during a render or commit: Ink's layout engine is not re-entrant. Returns
 * whether anything new was measured.
 */
export function measureTranscriptRows(lines: LogLine[], columns: number, banner: BannerInfo | null): boolean {
  let changed = banner ? measure(banner, columns, () => <Banner {...banner} />) : false;
  for (const line of lines.slice(-200)) {
    changed = measure(line, columns, () => <TranscriptEntry line={line} columns={columns} />) || changed;
  }
  return changed;
}

function measure(key: object, columns: number, element: () => React.ReactElement): boolean {
  const cached = measuredRows.get(key);
  if (cached && cached.columns === columns) {
    return false;
  }

  measuredRows.set(key, { columns, rows: renderToString(element(), { columns }).split("\n").length });
  return true;
}

function overestimateRows(line: LogLine, columns: number): number {
  const width = Math.max(10, columns - 8);
  const wrapped = (text: string): number => text.split("\n").reduce((rows, row) => rows + Math.max(1, Math.ceil(row.length / width)), 0);
  return 3 + wrapped(line.text) + (line.detail ? wrapped(line.detail) : 0) + (line.preview ? 1 : 0);
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
              <Text color="gray">⎿  {collapse(line.preview, props.columns - 7)}</Text>
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
