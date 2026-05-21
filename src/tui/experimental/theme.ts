import type { InkColor } from "../format.js";
import type { TranscriptBlockKind } from "../types.js";

/**
 * Shared visual language for the experimental shell: consistent symbols and
 * colors so tools, approvals, and run state read at a glance.
 */
export const symbols = {
  user: "›",
  assistant: "◆",
  tool: "⚡",
  diff: "±",
  approval: "⚠",
  error: "✗",
  final: "✓",
  status: "•",
  arrow: "→",
  bullet: "·",
  todoDone: "✓",
  todoActive: "▸",
  todoPending: "○",
  caret: "▏",
} as const;

export type ToneColor = InkColor;

/** Marker glyph for a transcript block kind. */
export function blockSymbol(kind: TranscriptBlockKind): string {
  switch (kind) {
    case "user":
      return symbols.user;
    case "assistant":
      return symbols.assistant;
    case "tool":
      return symbols.tool;
    case "diff":
      return symbols.diff;
    case "approval":
      return symbols.approval;
    case "error":
      return symbols.error;
    case "final":
      return symbols.final;
    case "status":
      return symbols.status;
  }
}

/** Accent color for a transcript block kind. */
export function blockColor(kind: TranscriptBlockKind, danger: boolean): InkColor {
  switch (kind) {
    case "user":
      return "white";
    case "assistant":
      return "cyan";
    case "tool":
      return danger ? "red" : "green";
    case "diff":
      return "yellow";
    case "approval":
      return "yellow";
    case "error":
      return "red";
    case "final":
      return "green";
    case "status":
      return "gray";
  }
}

/** Border / accent color that reflects the current work state. */
export function workStateColor(workState: string): InkColor {
  if (workState === "error") {
    return "red";
  }

  if (workState === "waiting_approval" || workState === "editing" || workState === "verifying") {
    return "yellow";
  }

  if (workState === "done" || workState === "idle") {
    return "green";
  }

  return "cyan";
}
