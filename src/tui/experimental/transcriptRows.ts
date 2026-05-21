import type { InkColor } from "../format.js";
import type { LogLine } from "../types.js";
import type { AgentTodoItem } from "../../core/types.js";
import { blockColor, blockSymbol, symbols } from "./theme.js";

export type ShellRow = {
  symbol: string;
  label: string;
  text: string;
  color: InkColor;
  bold?: boolean;
  dim?: boolean;
};

const LABEL_WIDTH = 12;
const GUTTER = 4; // symbol cell (2) + label gap (2)

/** Flatten transcript log lines into wrapped, renderable rows. */
export function buildShellRows(lines: LogLine[], width: number): ShellRow[] {
  const textWidth = Math.max(16, width - LABEL_WIDTH - GUTTER);
  return lines.flatMap((line): ShellRow[] => {
    const danger = line.tone === "danger" || line.tone === "warning";
    const color = blockColor(line.kind, danger);
    const symbol = blockSymbol(line.kind);
    const label = line.kind === "tool" && line.tool ? line.tool : line.label;
    const textRows = wrapText(line.text, textWidth);
    const metadata = [
      line.preview ? `preview ${line.preview}` : "",
      line.workState ? `state ${line.workState}` : "",
    ]
      .filter(Boolean)
      .join("  ");
    const detailSources = [line.detail, metadata].filter((value): value is string => Boolean(value));
    const detailRows = detailSources.flatMap((detail) => wrapText(detail, textWidth));

    const rows: ShellRow[] = textRows.map((text, index) => ({
      symbol: index === 0 ? symbol : "",
      label: index === 0 ? label.slice(0, LABEL_WIDTH) : "",
      text,
      color,
      bold: index === 0,
    }));

    for (const detail of detailRows) {
      rows.push({ symbol: "", label: "", text: detail, color: "gray", dim: true });
    }

    if (detailRows.length > 0) {
      rows.push({ symbol: "", label: "", text: "", color: "gray" });
    }

    return rows;
  });
}

/** Build the todo dock rows. */
export function buildTodoDock(todos: AgentTodoItem[], width: number, frame: number): ShellRow[] {
  if (todos.length === 0) {
    return [];
  }

  const textWidth = Math.max(16, width - LABEL_WIDTH - GUTTER);
  const completed = todos.filter((todo) => todo.status === "completed").length;
  const rows: ShellRow[] = [
    {
      symbol: symbols.bullet,
      label: "todos",
      text: `${completed}/${todos.length} complete`,
      color: "cyan",
      bold: true,
    },
  ];

  for (const todo of todos.slice(0, 6)) {
    const isActive = todo.status === "in_progress";
    const marker =
      todo.status === "completed"
        ? symbols.todoDone
        : isActive
          ? frame % 2 === 0
            ? symbols.todoActive
            : symbols.bullet
          : symbols.todoPending;
    const color: InkColor = todo.status === "completed" ? "green" : isActive ? "yellow" : "gray";
    rows.push({
      symbol: "",
      label: marker,
      text: truncate(todo.content, textWidth),
      color,
      bold: isActive,
      dim: todo.status === "pending",
    });
  }

  return rows;
}

export function truncate(value: string, width: number): string {
  if (value.length <= width) {
    return value;
  }

  return `${value.slice(0, Math.max(0, width - 1))}…`;
}

function wrapText(value: string, width: number): string[] {
  const rows = value.split(/\r?\n/).flatMap((line) => wrapLine(line, width));
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
    for (const chunk of chunkWord(word, width)) {
      const nextRow = currentRow ? `${currentRow} ${chunk}` : chunk;
      if (nextRow.length <= width) {
        currentRow = nextRow;
        continue;
      }

      if (currentRow) {
        rows.push(currentRow);
      }
      currentRow = chunk;
    }
  }

  if (currentRow) {
    rows.push(currentRow);
  }

  return rows.length > 0 ? rows : [""];
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
