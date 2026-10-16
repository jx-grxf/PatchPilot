/**
 * Cursor-aware view model for the experimental composer. The composer keeps a
 * cursor position so the user can navigate inside the draft with the arrow
 * keys, not just append at the end.
 */
export type ComposerView = {
  rows: string[];
  cursorRow: number;
  cursorCol: number;
  hiddenAbove: number;
  totalRows: number;
};

export type ComposerEditResult = {
  input: string;
  cursor: number;
};

export function insertComposerText(input: string, cursor: number, text: string): ComposerEditResult {
  const safeCursor = clampCursor(input, cursor);
  return {
    input: `${input.slice(0, safeCursor)}${text}${input.slice(safeCursor)}`,
    cursor: safeCursor + text.length,
  };
}

export function deleteComposerText(
  input: string,
  cursor: number,
  direction: "backward" | "forward",
): ComposerEditResult {
  const safeCursor = clampCursor(input, cursor);
  if (direction === "backward") {
    if (safeCursor === 0) {
      return { input, cursor: safeCursor };
    }

    return {
      input: `${input.slice(0, safeCursor - 1)}${input.slice(safeCursor)}`,
      cursor: safeCursor - 1,
    };
  }

  if (safeCursor >= input.length) {
    return { input, cursor: safeCursor };
  }

  return {
    input: `${input.slice(0, safeCursor)}${input.slice(safeCursor + 1)}`,
    cursor: safeCursor,
  };
}

/** Wrap a draft into rows, preserving explicit newlines, hard-chunking long lines. */
function wrapRows(input: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const rows: string[] = [];
  const paragraphs = input.length > 0 ? input.split("\n") : [""];
  for (const paragraph of paragraphs) {
    if (paragraph.length === 0) {
      rows.push("");
      continue;
    }

    for (let index = 0; index < paragraph.length; index += safeWidth) {
      rows.push(paragraph.slice(index, index + safeWidth));
    }
  }

  return rows.length > 0 ? rows : [""];
}

/**
 * Build the visible composer view for a given draft, cursor index and width.
 * The window of `editorRows` rows always includes the cursor row, so moving
 * the cursor up into earlier text scrolls the editor to follow it.
 */
export function composerView(input: string, cursor: number, width: number, editorRows: number): ComposerView {
  const safeWidth = Math.max(1, width);
  const visibleRows = Math.max(1, editorRows);
  const clampedCursor = clampCursor(input, cursor);
  const allRows = wrapRows(input, safeWidth);

  // Locate the cursor by walking the paragraphs the same way wrapRows does.
  const paragraphs = input.length > 0 ? input.split("\n") : [""];
  let rowBase = 0;
  let consumed = 0;
  let cursorRow = 0;
  let cursorCol = 0;
  for (const paragraph of paragraphs) {
    const rowsInParagraph = paragraph.length === 0 ? 1 : Math.ceil(paragraph.length / safeWidth);
    if (clampedCursor >= consumed && clampedCursor <= consumed + paragraph.length) {
      const offset = clampedCursor - consumed;
      const rowWithin = Math.min(rowsInParagraph - 1, Math.floor(offset / safeWidth));
      cursorRow = rowBase + rowWithin;
      cursorCol = offset - rowWithin * safeWidth;
    }
    rowBase += rowsInParagraph;
    consumed += paragraph.length + 1; // +1 for the newline
  }

  const maxStart = Math.max(0, allRows.length - visibleRows);
  const start = Math.max(0, Math.min(cursorRow - visibleRows + 1, maxStart, cursorRow));
  const windowed = allRows.slice(start, start + visibleRows);

  return {
    rows: windowed,
    cursorRow: cursorRow - start,
    cursorCol,
    hiddenAbove: start,
    totalRows: allRows.length,
  };
}

function clampCursor(input: string, cursor: number): number {
  return Math.max(0, Math.min(Math.trunc(cursor), input.length));
}
