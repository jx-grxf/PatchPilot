/**
 * One glyph per kind of entry, so a transcript reads by shape before colour:
 * every distinction here also has to survive a monochrome terminal.
 */
export const symbols = {
  user: "›",
  assistant: "◆",
  tool: "●",
  approval: "⚠",
  // A benign "update available" must never read like a destructive-action gate.
  update: "↑",
  // Thinking gets a quieter glyph than the answer it precedes.
  thinking: "∴",
  info: "i",
  error: "✗",
  final: "✓",
  status: "·",
  arrow: "→",
  bullet: "·",
  todoDone: "✓",
  todoActive: "▸",
  todoPending: "○"
} as const;
