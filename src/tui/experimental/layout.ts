import { computeComposerLayout } from "../layout.js";

/**
 * Layout math for the experimental fullscreen shell. Kept as pure functions so
 * the 80x24 / 120x40 / 207x47 acceptance cases can be covered without
 * rendering Ink.
 */
export type ExperimentalLayout = {
  rootHeight: number;
  rootWidth: number;
  headerHeight: number;
  bodyHeight: number;
  transcriptHeight: number;
  transcriptWidth: number;
  composerHeight: number;
  approvalHeight: number;
  paletteHeight: number;
  todoDockHeight: number;
  footerHeight: number;
};

const MIN_ROWS = 24;
const MIN_COLUMNS = 80;
const HEADER_HEIGHT = 4;
const FOOTER_HEIGHT = 1;
const APPROVAL_HEIGHT = 8;
const MIN_TRANSCRIPT_HEIGHT = 3;
const MAX_PALETTE_ROWS = 8;
const MAX_TODO_DOCK_ROWS = 6;

/** Height of the todo dock panel for a given number of todos (0 = hidden). */
export function todoDockHeightFor(todoCount: number): number {
  const count = Math.max(0, Math.floor(todoCount));
  if (count === 0) {
    return 0;
  }

  // header row + up to MAX_TODO_DOCK_ROWS items + rounded border (2).
  return Math.min(count, MAX_TODO_DOCK_ROWS) + 1 + 2;
}

export function computeExperimentalLayout(options: {
  rows: number;
  columns: number;
  composerInput: string;
  paletteItemCount: number;
  approvalActive: boolean;
  todoCount?: number;
}): ExperimentalLayout {
  const rootHeight = Math.max(MIN_ROWS, Math.floor(options.rows) || MIN_ROWS);
  const rootWidth = Math.max(MIN_COLUMNS, Math.floor(options.columns) || MIN_COLUMNS);

  // Inner content width: 1 cell of horizontal padding on each side.
  const contentWidth = Math.max(40, rootWidth - 2);
  // Transcript and composer sit inside a rounded border (2 columns).
  const transcriptWidth = Math.max(32, contentWidth - 2);

  const composerEditor = computeComposerLayout({
    input: options.composerInput,
    width: transcriptWidth,
    promptWidth: 2,
    minHeight: 3,
    maxHeight: 7,
  });
  // composer editor rows + status row + rounded border.
  const composerHeight = composerEditor.height + 2;

  const approvalHeight = options.approvalActive ? APPROVAL_HEIGHT : 0;

  const paletteRows = Math.min(MAX_PALETTE_ROWS, Math.max(0, options.paletteItemCount));
  // palette: header row + items + preview block (3) + border.
  const paletteHeight = paletteRows > 0 ? paletteRows + 6 : 0;

  const todoDockHeight = todoDockHeightFor(options.todoCount ?? 0);

  const fixed = HEADER_HEIGHT + FOOTER_HEIGHT + composerHeight + approvalHeight + paletteHeight + todoDockHeight;
  const transcriptHeight = Math.max(MIN_TRANSCRIPT_HEIGHT, rootHeight - fixed);
  const bodyHeight = rootHeight - HEADER_HEIGHT;

  return {
    rootHeight,
    rootWidth,
    headerHeight: HEADER_HEIGHT,
    bodyHeight,
    transcriptHeight,
    transcriptWidth,
    composerHeight,
    approvalHeight,
    paletteHeight,
    todoDockHeight,
    footerHeight: FOOTER_HEIGHT,
  };
}

export type RowWindow = {
  start: number;
  end: number;
  anchored: "top" | "bottom";
  clampedOffset: number;
  hasOverflow: boolean;
};

/**
 * Window a list of rows into a viewport.
 *
 * - When the content fits, it is anchored to the TOP (short outputs start at
 *   the top, no artificial blank lines — the caller pads with flexGrow).
 * - When it overflows, it is anchored to the BOTTOM and `scrollOffset` walks
 *   the window upward.
 */
export function windowRows(totalRows: number, viewportHeight: number, scrollOffset: number): RowWindow {
  const total = Math.max(0, Math.floor(totalRows));
  const viewport = Math.max(1, Math.floor(viewportHeight));

  if (total <= viewport) {
    return { start: 0, end: total, anchored: "top", clampedOffset: 0, hasOverflow: false };
  }

  const maxOffset = total - viewport;
  const clampedOffset = Math.max(0, Math.min(Math.floor(scrollOffset), maxOffset));
  const end = total - clampedOffset;
  const start = Math.max(0, end - viewport);
  return { start, end, anchored: "bottom", clampedOffset, hasOverflow: true };
}
