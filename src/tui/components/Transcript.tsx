import React from "react";
import { Box, Text } from "ink";
import { toneToColor, toneToMarker, type InkColor } from "../format.js";
import { formatWorkingStatus } from "../layout.js";
import type { LogLine } from "../types.js";
import type { AgentTodoItem, AgentWorkState } from "../../core/types.js";
import { StartupBanner } from "./StartupBanner.js";

type TranscriptRow = {
  marker: string;
  label: string;
  text: string;
  color: InkColor;
  bold?: boolean;
  dim?: boolean;
};

export function Transcript(props: {
  lines: LogLine[];
  isRunning: boolean;
  isActive: boolean;
  height: number;
  width: number;
  scrollOffset: number;
  todos?: AgentTodoItem[];
  todoFrame?: number;
  verbIndex?: number;
  status: string;
  workState: AgentWorkState;
  isApprovalWaiting?: boolean;
}): React.ReactElement {
  const rows = buildTranscriptRows(props.lines, props.width);
  const visibleRowCount = Math.max(1, props.height - 2);
  const todoRows = buildTodoRows(props.todos ?? [], props.width, props.todoFrame ?? 0);
  const dockRows = buildDockRows({
    isRunning: props.isRunning,
    isApprovalWaiting: Boolean(props.isApprovalWaiting),
    status: props.status,
    workState: props.workState,
    todos: props.todos ?? [],
    width: props.width,
    verbIndex: props.verbIndex ?? 0
  });
  // The todo block and the run/approval dock stay pinned at the bottom; the
  // content region above them flexes to fill whatever is left. The dock is
  // capped so it can never crowd out the transcript on a tiny terminal.
  const auxRows = [...todoRows, ...dockRows];
  const reservedAuxRows = Math.min(auxRows.length, Math.max(0, visibleRowCount - 1));
  const visibleAuxRows = auxRows.slice(0, reservedAuxRows);
  const contentRowCount = Math.max(1, visibleRowCount - reservedAuxRows);
  const hasOverflow = rows.length > contentRowCount;
  const clampedOffset = clampScrollOffset(props.scrollOffset, rows.length, hasOverflow ? contentRowCount - 1 : contentRowCount);
  const contentCapacity = hasOverflow ? Math.max(1, contentRowCount - 1) : contentRowCount;
  const visibleRows = rows.slice(Math.max(0, rows.length - contentCapacity - clampedOffset), rows.length - clampedOffset);
  const showBanner = props.lines.length === 0 && visibleRows.length === 0;

  return (
    <Box
      borderStyle="round"
      borderColor={props.isActive ? "cyan" : props.isRunning ? "yellow" : "gray"}
      flexDirection="column"
      paddingX={1}
      height={props.height}
      overflowY="hidden"
    >
      {/* Content region: short output stays anchored at the top, the flex gap
          below pushes the dock down — no artificial blank lines. */}
      <Box flexDirection="column" flexGrow={1} overflowY="hidden">
        {showBanner ? (
          <StartupBanner compact={props.height < 22 || props.width < 92} />
        ) : (
          visibleRows.map((row, index) => <TranscriptRowView key={`row-${index}`} row={row} />)
        )}
        {hasOverflow ? <ScrollHint offset={clampedOffset} total={rows.length} visible={contentCapacity} /> : null}
      </Box>
      {visibleAuxRows.length > 0 ? (
        <Box flexDirection="column">
          {visibleAuxRows.map((row, index) => (
            <TranscriptRowView key={`aux-${index}`} row={row} />
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

function TranscriptRowView(props: { row: TranscriptRow }): React.ReactElement {
  return (
    <Box>
      <Box width={3}>
        <Text color={props.row.color} dimColor={props.row.dim}>{props.row.marker}</Text>
      </Box>
      <Box width={14}>
        <Text color={props.row.color} bold={props.row.bold} dimColor={props.row.dim}>
          {props.row.label}
        </Text>
      </Box>
      <Text color={props.row.color} wrap="truncate" dimColor={props.row.dim}>
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
  const textWidth = Math.max(18, width - 19);
  return lines.flatMap((line): TranscriptRow[] => {
    const color = colorForBlock(line);
    const marker = markerForBlock(line);
    const label = labelForBlock(line);
    const textRows = wrapText(line.text, textWidth);
    const metadata = [line.preview, line.workState ? `state ${line.workState}` : "", line.toolCallId ? `id ${line.toolCallId}` : ""].filter(Boolean).join("  ");
    const detailRows = [line.detail, metadata].filter(Boolean).flatMap((detail) => wrapText(detail as string, textWidth));
    const rows: TranscriptRow[] = textRows.map((text, index) => ({
      marker: index === 0 ? marker : "",
      label: index === 0 ? label : "",
      text,
      color,
      bold: index === 0,
      dim: false
    }));

    rows.push(
      ...detailRows.map((text) => ({
        marker: "",
        label: "",
        text,
        color: "gray" as const,
        dim: false
      }))
    );

    if (detailRows.length > 0) {
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

function buildTodoRows(todos: AgentTodoItem[], width: number, frame: number): TranscriptRow[] {
  if (todos.length === 0) {
    return [];
  }

  const textWidth = Math.max(18, width - 19);
  const spinner = ["-", "\\", "|", "/"][frame % 4] ?? "-";
  const rows: TranscriptRow[] = [
    {
      marker: "",
      label: "todos",
      text: `${todos.filter((todo) => todo.status === "completed").length}/${todos.length} complete`,
      color: "cyan",
      bold: true
    }
  ];

  for (const todo of todos.slice(0, 8)) {
    const marker = todo.status === "completed" ? "[x]" : todo.status === "in_progress" ? `[${spinner}]` : "[ ]";
    const color: InkColor = todo.status === "completed" ? "green" : todo.status === "in_progress" ? "yellow" : "gray";
    rows.push({
      marker: "",
      label: marker,
      text: truncate(todo.content, textWidth),
      color,
      bold: todo.status === "in_progress",
      dim: todo.status === "pending"
    });
  }

  return rows;
}

function buildDockRows(options: {
  isRunning: boolean;
  isApprovalWaiting: boolean;
  status: string;
  workState: AgentWorkState;
  todos: AgentTodoItem[];
  width: number;
  verbIndex: number;
}): TranscriptRow[] {
  const textWidth = Math.max(18, options.width - 19);
  const rows: TranscriptRow[] = [];

  if (options.isApprovalWaiting) {
    rows.push({
      marker: "?",
      label: "approval",
      text: "Review the request below. Session approvals are scoped to the concrete target.",
      color: "yellow",
      bold: true
    });
  }

  if (options.isRunning) {
    rows.push({
      marker: "#",
      label: "run",
      text: truncate(formatWorkingStatus(options.workState, options.verbIndex, options.status), textWidth),
      color: "cyan",
      bold: true
    });
  }

  if (options.todos.length === 0 && !options.isRunning && !options.isApprovalWaiting) {
    rows.push({
      marker: "",
      label: "ready",
      text: "Ask for a repo summary, a focused patch, or type /help.",
      color: "gray"
    });
  }

  return rows;
}

function markerForBlock(line: LogLine): string {
  switch (line.kind) {
    case "user":
      return ">";
    case "assistant":
      return "<";
    case "tool":
      return "#";
    case "diff":
      return "+";
    case "approval":
      return "?";
    case "error":
      return "!";
    case "final":
      return "=";
    case "status":
      return toneToMarker(line.tone);
  }
}

function labelForBlock(line: LogLine): string {
  if (line.kind === "tool" && line.tool) {
    return line.tool;
  }

  return line.label;
}

function colorForBlock(line: LogLine): InkColor {
  switch (line.kind) {
    case "user":
      return "white";
    case "assistant":
      return "cyan";
    case "tool":
      return line.tone === "danger" || line.tone === "warning" ? toneToColor(line.tone) : "green";
    case "diff":
      return "yellow";
    case "approval":
      return "yellow";
    case "error":
      return "red";
    case "final":
      return "green";
    case "status":
      return toneToColor(line.tone);
  }
}

function clampScrollOffset(offset: number, rowCount: number, visibleRowCount: number): number {
  return Math.max(0, Math.min(offset, Math.max(0, rowCount - visibleRowCount)));
}

function truncate(value: string, width: number): string {
  if (value.length <= width) {
    return value;
  }
  return `${value.slice(0, Math.max(0, width - 3))}...`;
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
