import type { InkColor } from "../format.js";
import type { LogLine } from "../types.js";
import type { AgentTodoItem } from "../../core/types.js";
import { blockColor, blockSymbol, symbols } from "./theme.js";

export type ShellRow = {
  symbol: string;
  label: string;
  text: string;
  color: InkColor;
  symbolColor?: InkColor;
  labelColor?: InkColor;
  textColor?: InkColor;
  effect?: "rainbow";
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
    const labelColor = labelAccentColor(line.kind, label, line.workState, danger);
    const textColor = bodyColor(line.kind, danger);
    const effect = label.toLowerCase() === "ultramaxx" ? "rainbow" : undefined;
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
      symbolColor: labelColor,
      labelColor,
      textColor,
      effect: index === 0 ? effect : undefined,
      bold: index === 0,
    }));

    for (const detail of detailRows) {
      rows.push({ symbol: "", label: "", text: detail, color: "gray", dim: true });
    }

    return rows;
  });
}

function labelAccentColor(
  kind: LogLine["kind"],
  label: string,
  workState: LogLine["workState"],
  danger: boolean,
): InkColor {
  const normalized = label.toLowerCase();
  if (danger || normalized === "stop" || workState === "error") {
    return "red";
  }
  if (normalized === "ultramaxx") {
    return "magenta";
  }
  if (normalized === "planning" || workState === "planning" || normalized === "usage") {
    return "blue";
  }
  if (normalized === "gemini-wrapper" || normalized === "gemini" || normalized === "attach") {
    return "cyan";
  }
  if (normalized === "update" || normalized === "approval" || workState === "waiting_approval" || workState === "editing" || workState === "verifying") {
    return "yellow";
  }
  if (kind === "tool") {
    return "green";
  }
  if (kind === "diff") {
    return "yellow";
  }
  if (kind === "final" || workState === "done" || workState === "idle") {
    return "green";
  }
  if (kind === "assistant") {
    return "cyan";
  }
  return "gray";
}

function bodyColor(kind: LogLine["kind"], danger: boolean): InkColor {
  if (danger || kind === "error") {
    return "red";
  }
  if (kind === "user") {
    return "white";
  }
  if (kind === "final") {
    return "white";
  }
  return "gray";
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
