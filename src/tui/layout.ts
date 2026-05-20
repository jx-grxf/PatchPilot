import type { AgentWorkState } from "../core/types.js";

export type ComposerLayout = {
  height: number;
  editorRows: number;
  inputWidth: number;
  visibleRows: string[];
  cursorRow: number;
  cursorColumn: number;
  hiddenRows: number;
};

export function computeComposerLayout(options: {
  input: string;
  width: number;
  promptWidth?: number;
  minHeight?: number;
  maxHeight?: number;
}): ComposerLayout {
  const promptWidth = options.promptWidth ?? 9;
  const minHeight = options.minHeight ?? 2;
  const maxHeight = options.maxHeight ?? 6;
  const inputWidth = Math.max(12, options.width - promptWidth - 4);
  const rows = wrapDraftRows(options.input, inputWidth);
  const desiredEditorRows = Math.max(1, rows.length);
  const height = clamp(desiredEditorRows + 1, minHeight, maxHeight);
  const editorRows = Math.max(1, height - 1);
  const visibleRows = rows.slice(-editorRows);
  const hiddenRows = Math.max(0, rows.length - visibleRows.length);
  const cursorRow = visibleRows.length - 1;
  const cursorColumn = visibleRows.at(-1)?.length ?? 0;

  return {
    height,
    editorRows,
    inputWidth,
    visibleRows,
    cursorRow,
    cursorColumn,
    hiddenRows
  };
}

export function wrapDraftRows(value: string, width: number): string[] {
  const rows: string[] = [];
  const paragraphs = value.length > 0 ? value.split("\n") : [""];
  for (const paragraph of paragraphs) {
    if (paragraph.length === 0) {
      rows.push("");
      continue;
    }

    for (let index = 0; index < paragraph.length; index += width) {
      rows.push(paragraph.slice(index, index + width));
    }
  }

  return rows.length > 0 ? rows : [""];
}

export function formatWorkingStatus(workState: AgentWorkState, frame: number, status: string): string {
  const verb = workingVerbs[Math.abs(frame) % workingVerbs.length] ?? "Working";
  const state = workState.replace(/_/g, " ");
  const detail = status && status !== state ? `: ${status}` : "";
  return `${verb} ${state}${detail}`;
}

const workingVerbs = [
  "Planning",
  "Inspecting",
  "Reading",
  "Checking",
  "Reviewing",
  "Composing",
  "Verifying",
  "Refining"
];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
