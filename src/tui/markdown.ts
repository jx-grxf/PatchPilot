/**
 * A small Markdown reader for the transcript.
 *
 * Models write Markdown whether or not you ask them to, so the transcript has
 * to render it. This parses to a structure rather than to ANSI, because Ink
 * composes React nodes: emitting escape codes into a `<Text>` fights the
 * renderer's own width and wrapping logic.
 *
 * Deliberately partial. It covers what models actually emit — headings, lists,
 * fenced code, tables as plain rows, inline emphasis and code — and ignores
 * the rest of CommonMark rather than pretending to implement it.
 */

export type InlineStyle = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
  link?: boolean;
};

export type MarkdownBlock =
  | { kind: "paragraph"; spans: InlineStyle[] }
  | { kind: "heading"; level: number; spans: InlineStyle[] }
  | { kind: "listItem"; depth: number; marker: string; spans: InlineStyle[] }
  | { kind: "quote"; spans: InlineStyle[] }
  | { kind: "code"; language: string | null; lines: string[] }
  | { kind: "rule" }
  | { kind: "blank" };

const fencePattern = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;
const headingPattern = /^(#{1,6})\s+(.*)$/;
const bulletPattern = /^(\s*)([-*+])\s+(.*)$/;
const orderedPattern = /^(\s*)(\d{1,3})[.)]\s+(.*)$/;
const quotePattern = /^\s*>\s?(.*)$/;
const rulePattern = /^\s*([-*_])(\s*\1){2,}\s*$/;
const tableRowPattern = /^\s*\|(.+)\|\s*$/;
const tableDividerPattern = /^\s*\|[\s:|-]+\|\s*$/;

export function parseMarkdown(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = source.replace(/\r\n/g, "\n").split("\n");

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";

    const fence = fencePattern.exec(line);
    if (fence) {
      const marker = fence[1] ?? "```";
      const language = fence[2]?.trim() || null;
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").trimStart().startsWith(marker)) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      index += 1; // closing fence, or end of input when the model was cut off
      blocks.push({ kind: "code", language, lines: body });
      continue;
    }

    if (line.trim() === "") {
      blocks.push({ kind: "blank" });
      index += 1;
      continue;
    }

    if (rulePattern.test(line)) {
      blocks.push({ kind: "rule" });
      index += 1;
      continue;
    }

    const heading = headingPattern.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1]?.length ?? 1, spans: parseInline(heading[2] ?? "") });
      index += 1;
      continue;
    }

    const quote = quotePattern.exec(line);
    if (quote) {
      blocks.push({ kind: "quote", spans: parseInline(quote[1] ?? "") });
      index += 1;
      continue;
    }

    const bullet = bulletPattern.exec(line);
    if (bullet) {
      blocks.push({
        kind: "listItem",
        depth: Math.floor((bullet[1]?.length ?? 0) / 2),
        marker: "•",
        spans: parseInline(bullet[3] ?? "")
      });
      index += 1;
      continue;
    }

    const ordered = orderedPattern.exec(line);
    if (ordered) {
      blocks.push({
        kind: "listItem",
        depth: Math.floor((ordered[1]?.length ?? 0) / 2),
        marker: `${ordered[2]}.`,
        spans: parseInline(ordered[3] ?? "")
      });
      index += 1;
      continue;
    }

    // Tables are rendered as their rows. A real table needs column
    // measurement the transcript cannot do while streaming.
    if (tableRowPattern.test(line)) {
      if (!tableDividerPattern.test(line)) {
        const cells = (tableRowPattern.exec(line)?.[1] ?? "").split("|").map((cell) => cell.trim());
        blocks.push({ kind: "paragraph", spans: parseInline(cells.join("  ·  ")) });
      }
      index += 1;
      continue;
    }

    blocks.push({ kind: "paragraph", spans: parseInline(line) });
    index += 1;
  }

  return blocks;
}

/**
 * Inline emphasis, resolved in one left-to-right pass. Code spans win over
 * everything else, since backticks are how a model quotes a path or a flag
 * that would otherwise be mangled by emphasis rules.
 */
export function parseInline(source: string): InlineStyle[] {
  const spans: InlineStyle[] = [];
  let buffer = "";
  let index = 0;

  const flush = (): void => {
    if (buffer) {
      spans.push({ text: buffer });
      buffer = "";
    }
  };

  while (index < source.length) {
    const rest = source.slice(index);

    const code = /^`([^`]+)`/.exec(rest);
    if (code) {
      flush();
      spans.push({ text: code[1] ?? "", code: true });
      index += code[0].length;
      continue;
    }

    const bold = /^(\*\*|__)(.+?)\1/.exec(rest);
    if (bold) {
      flush();
      spans.push(...parseInline(bold[2] ?? "").map((span) => ({ ...span, bold: true })));
      index += bold[0].length;
      continue;
    }

    const strike = /^~~(.+?)~~/.exec(rest);
    if (strike) {
      flush();
      spans.push(...parseInline(strike[1] ?? "").map((span) => ({ ...span, strike: true })));
      index += strike[0].length;
      continue;
    }

    // Emphasis only where real Markdown starts one: at the beginning of a run
    // or after whitespace or an opening bracket. Without that, snake_case
    // identifiers and glob patterns like src/**/*.ts get eaten.
    const italic = /^(\*|_)(?![\s*_])([^/\n]+?)(?<![\s*_])\1(?![\w*_/])/.exec(rest);
    if (italic && canOpenEmphasis(source, index)) {
      flush();
      spans.push(...parseInline(italic[2] ?? "").map((span) => ({ ...span, italic: true })));
      index += italic[0].length;
      continue;
    }

    const link = /^\[([^\]]*)\]\(([^)\s]+)[^)]*\)/.exec(rest);
    if (link) {
      flush();
      const label = link[1]?.trim();
      spans.push({ text: label || (link[2] ?? ""), link: true });
      index += link[0].length;
      continue;
    }

    const bareUrl = /^https?:\/\/\S+/.exec(rest);
    if (bareUrl) {
      flush();
      spans.push({ text: bareUrl[0], link: true });
      index += bareUrl[0].length;
      continue;
    }

    buffer += source[index];
    index += 1;
  }

  flush();
  return spans.length > 0 ? spans : [{ text: "" }];
}

function canOpenEmphasis(source: string, index: number): boolean {
  if (index === 0) {
    return true;
  }

  return /[\s([{"']/.test(source[index - 1] ?? "");
}

/** Plain text of a parsed run, for widths, logs and tests. */
export function spansToText(spans: InlineStyle[]): string {
  return spans.map((span) => span.text).join("");
}
