import React from "react";
import { Box, Text } from "ink";
import { toneToColor, toneToMarker, type InkColor } from "../format.js";
import type { LogLine } from "../types.js";

type TranscriptRow = {
  marker: string;
  label: string;
  text: string;
  color: InkColor;
  bold?: boolean;
};

export function Transcript(props: {
  lines: LogLine[];
  isRunning: boolean;
  height: number;
  width: number;
  scrollOffset: number;
}): React.ReactElement {
  const rows = props.lines.length === 0 ? emptyRows() : buildTranscriptRows(props.lines, props.width);
  const visibleRowCount = Math.max(1, props.height - 2);
  const hasOverflow = rows.length > visibleRowCount;
  const contentRowCount = hasOverflow ? Math.max(1, visibleRowCount - 1) : visibleRowCount;
  const clampedOffset = clampScrollOffset(props.scrollOffset, rows.length, contentRowCount);
  const visibleRows = rows.slice(Math.max(0, rows.length - contentRowCount - clampedOffset), rows.length - clampedOffset);

  return (
    <Box
      borderStyle="round"
      borderColor={props.isRunning ? "cyan" : "gray"}
      flexDirection="column"
      paddingX={1}
      height={props.height}
      overflowY="hidden"
      flexGrow={1}
    >
      {visibleRows.map((row, index) => (
        <TranscriptRowView key={`${index}-${row.marker}-${row.label}-${row.text}`} row={row} />
      ))}
      {hasOverflow ? <ScrollHint offset={clampedOffset} total={rows.length} visible={contentRowCount} /> : null}
    </Box>
  );
}

function TranscriptRowView(props: { row: TranscriptRow }): React.ReactElement {
  return (
    <Box>
      <Box width={3}>
        <Text color={props.row.color}>{props.row.marker}</Text>
      </Box>
      <Box width={13}>
        <Text color={props.row.color} bold={props.row.bold}>
          {props.row.label}
        </Text>
      </Box>
      <Text color={props.row.color} wrap="truncate">
        {props.row.text}
      </Text>
    </Box>
  );
}

function ScrollHint(props: { offset: number; total: number; visible: number }): React.ReactElement {
  const start = Math.max(1, props.total - props.visible - props.offset + 1);
  const end = Math.min(props.total, props.total - props.offset);
  return (
    <Box>
      <Box width={16}>
        <Text color="gray">scroll</Text>
      </Box>
      <Text color="gray">
        {start}-{end}/{props.total} pgup/pgdn
      </Text>
    </Box>
  );
}

function buildTranscriptRows(lines: LogLine[], width: number): TranscriptRow[] {
  const textWidth = Math.max(18, width - 18);
  return lines.flatMap((line): TranscriptRow[] => {
    const color = toneToColor(line.tone);
    const marker = toneToMarker(line.tone);
    const textRows = wrapText(line.text, textWidth);
    const detailRows = line.detail ? wrapText(line.detail, textWidth) : [];
    const rows: TranscriptRow[] = textRows.map((text, index) => ({
      marker: index === 0 ? marker : "",
      label: index === 0 ? line.label : "",
      text,
      color,
      bold: index === 0
    }));

    rows.push(
      ...detailRows.map((text) => ({
        marker: "",
        label: "",
        text,
        color: "gray" as const
      }))
    );

    if (line.detail) {
      rows.push({
        marker: "",
        label: "",
        text: "",
        color: "gray"
      });
    }

    return rows;
  });
}

function emptyRows(): TranscriptRow[] {
  return [
    {
      marker: "",
      label: "",
      text: "No session activity yet.",
      color: "gray"
    },
    {
      marker: "",
      label: "",
      text: "Ask for a repo summary, a focused patch, or type /help.",
      color: "gray"
    }
  ];
}

function clampScrollOffset(offset: number, rowCount: number, visibleRowCount: number): number {
  return Math.max(0, Math.min(offset, Math.max(0, rowCount - visibleRowCount)));
}

function wrapText(value: string, width: number): string[] {
  const rows = value
    .split(/\r?\n/)
    .flatMap((line) => wrapLine(line, width));
  return rows.length > 0 ? rows : [""];
}

function wrapLine(value: string, width: number): string[] {
  const words = value.trimEnd().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return [""];
  }

  const rows: string[] = [];
  let currentRow = "";
  for (const word of words) {
    const chunks = chunkWord(word, width);
    for (const chunk of chunks) {
      const nextRow = currentRow ? `${currentRow} ${chunk}` : chunk;
      if (nextRow.length <= width) {
        currentRow = nextRow;
        continue;
      }

      rows.push(currentRow);
      currentRow = chunk;
    }
  }

  if (currentRow) {
    rows.push(currentRow);
  }

  return rows;
}

function chunkWord(word: string, width: number): string[] {
  if (word.length <= width) {
    return [word];
  }

  const chunks: string[] = [];
  for (let index = 0; index < word.length; index += width) {
    chunks.push(word.slice(index, index + width));
  }

  return chunks;
}
