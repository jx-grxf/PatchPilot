/**
 * Markdown for the terminal.
 *
 * Two things shape this parser. First, assistant output arrives *while it is
 * being written*, so a half-open code fence or a lone `**` is the normal case,
 * not a malformed document — the parser has to render those states without
 * flickering between interpretations as more text lands. Second, a terminal
 * has no fonts: every distinction has to survive in weight, colour and symbol
 * alone, which means the block set stays small and each block earns its place.
 */

export type InlineSpan = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
  /** Link target, when the span came from [text](href). */
  href?: string;
};

export type MarkdownBlock =
  | { kind: "paragraph"; spans: InlineSpan[] }
  | { kind: "heading"; level: 1 | 2 | 3; spans: InlineSpan[] }
  | { kind: "bullet"; depth: number; spans: InlineSpan[] }
  | { kind: "ordered"; depth: number; marker: string; spans: InlineSpan[] }
  | { kind: "quote"; spans: InlineSpan[] }
  | { kind: "code"; language: string; lines: string[]; open: boolean }
  | { kind: "rule" }
  | { kind: "blank" };

/**
 * Splits text into blocks. `open` on a code block means the closing fence has
 * not arrived yet — the caller can render it as code immediately rather than
 * waiting, which is what makes streaming output readable.
 */
export function parseMarkdown(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";

    const fence = /^\s*```+\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const language = (fence[1] ?? "").toLowerCase();
      const body: string[] = [];
      index += 1;
      let closed = false;
      while (index < lines.length) {
        if (/^\s*```+\s*$/.test(lines[index] ?? "")) {
          closed = true;
          index += 1;
          break;
        }
        body.push(lines[index] ?? "");
        index += 1;
      }
      blocks.push({ kind: "code", language, lines: body, open: !closed });
      continue;
    }

    if (line.trim() === "") {
      blocks.push({ kind: "blank" });
      index += 1;
      continue;
    }

    if (/^\s*(?:-\s*-\s*-|\*\s*\*\s*\*|_\s*_\s*_)[-*_\s]*$/.test(line)) {
      blocks.push({ kind: "rule" });
      index += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const hashes = heading[1]?.length ?? 1;
      blocks.push({
        kind: "heading",
        level: hashes >= 3 ? 3 : (hashes as 1 | 2),
        spans: parseInline(heading[2] ?? "")
      });
      index += 1;
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      blocks.push({ kind: "quote", spans: parseInline(quote[1] ?? "") });
      index += 1;
      continue;
    }

    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      blocks.push({
        kind: "bullet",
        depth: indentDepth(bullet[1] ?? ""),
        spans: parseInline(bullet[2] ?? "")
      });
      index += 1;
      continue;
    }

    const ordered = /^(\s*)(\d{1,3})[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      blocks.push({
        kind: "ordered",
        depth: indentDepth(ordered[1] ?? ""),
        marker: ordered[2] ?? "1",
        spans: parseInline(ordered[3] ?? "")
      });
      index += 1;
      continue;
    }

    blocks.push({ kind: "paragraph", spans: parseInline(line) });
    index += 1;
  }

  return blocks;
}

/** Two spaces or one tab per level, capped so deep nesting cannot run off. */
function indentDepth(indent: string): number {
  return Math.min(3, Math.floor(indent.replace(/\t/g, "  ").length / 2));
}

type Marker = {
  open: string;
  close: string;
  apply: (span: InlineSpan) => InlineSpan;
};

// Longest first: `**` must win over `*`, and ``` over `.
const markers: Marker[] = [
  { open: "```", close: "```", apply: (span) => ({ ...span, code: true }) },
  { open: "**", close: "**", apply: (span) => ({ ...span, bold: true }) },
  { open: "__", close: "__", apply: (span) => ({ ...span, bold: true }) },
  { open: "~~", close: "~~", apply: (span) => ({ ...span, strike: true }) },
  { open: "`", close: "`", apply: (span) => ({ ...span, code: true }) },
  { open: "*", close: "*", apply: (span) => ({ ...span, italic: true }) },
  { open: "_", close: "_", apply: (span) => ({ ...span, italic: true }) }
];

/**
 * Parses inline emphasis, code and links.
 *
 * An unclosed marker is rendered as the literal characters the user typed.
 * That matters while streaming: a `**` that has not met its partner yet must
 * not turn the entire rest of the message bold and then snap back.
 */
export function parseInline(source: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  let plain = "";
  let index = 0;

  const flush = (): void => {
    if (plain) {
      spans.push({ text: plain });
      plain = "";
    }
  };

  while (index < source.length) {
    // Links first: their label may itself contain emphasis markers.
    const link = /^\[([^\]\n]*)\]\(([^)\s]+)[^)]*\)/.exec(source.slice(index));
    if (link) {
      flush();
      spans.push({ text: link[1] || (link[2] ?? ""), href: link[2] ?? "" });
      index += link[0].length;
      continue;
    }

    if (source[index] === "\\" && index + 1 < source.length) {
      plain += source[index + 1];
      index += 2;
      continue;
    }

    const marker = markers.find(
      (candidate) => source.startsWith(candidate.open, index) && canOpenEmphasis(source, index, candidate)
    );
    if (marker) {
      const contentStart = index + marker.open.length;
      const closeAt = source.indexOf(marker.close, contentStart);
      // An emphasis marker with nothing between it is literal text, not markup.
      if (closeAt !== -1 && closeAt > contentStart) {
        flush();
        const inner = source.slice(contentStart, closeAt);
        // Code spans are literal all the way down; everything else may nest.
        const children = marker.apply({ text: "" }).code ? [{ text: inner }] : parseInline(inner);
        for (const child of children) {
          spans.push(marker.apply({ ...child }));
        }
        index = closeAt + marker.close.length;
        continue;
      }
    }

    plain += source[index];
    index += 1;
  }

  flush();
  return spans;
}

/**
 * A simplified CommonMark left-flanking check.
 *
 * Without it a path like `src/**` + `/*.ts` reads as emphasis and the stars
 * vanish from a glob the user needs to see. The rule: an emphasis run opens
 * only when it is not followed by whitespace and not preceded by a word
 * character — which is exactly what separates `**bold**` from a path. Code
 * spans are exempt: a backtick is unambiguous wherever it appears.
 */
function canOpenEmphasis(source: string, index: number, marker: Marker): boolean {
  if (marker.open.startsWith("`")) {
    return true;
  }

  const before = index > 0 ? source[index - 1] ?? "" : "";
  const after = source[index + marker.open.length] ?? "";

  if (after === "" || /\s/.test(after)) {
    return false;
  }

  // The marker characters themselves block an opening too: in `src/**/*.ts`
  // the second star of the pair would otherwise open italics on its own.
  return !/[\w/\\.*_~]/.test(before);
}

/** Flattens spans back to text, for widths and tests. */
export function spansToText(spans: InlineSpan[]): string {
  return spans.map((span) => span.text).join("");
}
