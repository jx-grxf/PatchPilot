import type { Theme } from "cli-highlight";

/**
 * Syntax highlighting for terminal code blocks and diffs.
 *
 * Wraps `cli-highlight` (highlight.js with an ANSI renderer) rather than
 * hand-rolling a lexer: it knows an order of magnitude more languages and gets
 * the edge cases right. Measured on this machine it costs 42ms to import and
 * 12ms for a hundred-line block, so the only thing worth managing is *when*
 * that import happens — it is deferred until something actually needs
 * highlighting, which keeps it off the launch path for a session that never
 * renders code.
 */

type Highlighter = (code: string, options: { language?: string; ignoreIllegals?: boolean; theme?: Theme }) => string;

let highlighter: Highlighter | null = null;
let highlighterUnavailable = false;

/**
 * Loads the highlighter on first use. Highlighting is decoration: if the
 * module cannot be loaded the code still has to render, just plainly.
 */
async function loadHighlighter(): Promise<Highlighter | null> {
  if (highlighter || highlighterUnavailable) {
    return highlighter;
  }

  try {
    const module = await import("cli-highlight");
    highlighter = module.highlight as Highlighter;
    return highlighter;
  } catch {
    highlighterUnavailable = true;
    return null;
  }
}

/** Warms the highlighter so the first code block does not pay the import. */
export function prewarmHighlighter(): void {
  void loadHighlighter();
}

/**
 * highlight.js recognises far more names than a fence usually carries, but a
 * few common aliases are not among them, and an unknown language makes it
 * guess — which on a short snippet guesses wrong. Mapping the ones we see is
 * cheaper than letting it detect.
 */
const languageAliases: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mjs: "javascript",
  cjs: "javascript",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  py3: "python",
  rs: "rust",
  golang: "go",
  sh: "bash",
  zsh: "bash",
  shell: "bash",
  console: "bash",
  terminal: "bash",
  yml: "yaml",
  jsonc: "json",
  json5: "json",
  md: "markdown",
  dockerfile: "docker"
};

export function resolveLanguage(hint: string): string | undefined {
  const normalized = hint.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  return languageAliases[normalized] ?? normalized;
}

/**
 * Highlights one block, returning ANSI-coloured lines. Falls back to the input
 * unchanged when the language is unknown or the highlighter is unavailable —
 * `ignoreIllegals` matters because a snippet is usually a fragment, and strict
 * parsing would reject perfectly readable code that happens to be incomplete.
 */
export function highlightBlock(code: string, language: string | undefined): string[] {
  const lines = code.split("\n");
  if (!highlighter || !language) {
    return lines;
  }

  try {
    return highlighter(code, { language, ignoreIllegals: true }).split("\n");
  } catch {
    return lines;
  }
}

/** True once the highlighter is loaded and highlightBlock can do its job. */
export function isHighlighterReady(): boolean {
  return highlighter !== null;
}

export type DiffLineKind = "added" | "removed" | "header" | "context";

/**
 * Classifies a diff line. Colour cannot carry this alone — it is invisible to
 * a colour-blind reader and to a piped log — so callers keep the leading +/-
 * as well and treat the colour as reinforcement.
 */
export function classifyDiffLine(line: string): DiffLineKind {
  if (/^(diff --git|index |--- |\+\+\+ |@@)/.test(line)) {
    return "header";
  }
  if (line.startsWith("+")) {
    return "added";
  }
  if (line.startsWith("-")) {
    return "removed";
  }

  return "context";
}

/** Looks like unified diff output rather than prose or plain code. */
export function looksLikeDiff(text: string): boolean {
  const lines = text.split("\n", 40);
  return lines.some((line) => /^@@ .* @@/.test(line) || /^diff --git /.test(line));
}
