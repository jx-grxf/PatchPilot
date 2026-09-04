import { describe, expect, it } from "vitest";
import { classifyDiffLine, highlightLine, isDiffLanguage, resolveLanguage } from "../src/tui/highlight.js";
import { parseInline, parseMarkdown, spansToText, type InlineStyle, type MarkdownBlock } from "../src/tui/markdown.js";

function kinds(blocks: MarkdownBlock[]): string[] {
  return blocks.filter((block) => block.kind !== "blank").map((block) => block.kind);
}

/** Narrows to the blocks that carry inline spans. */
function spansOf(block: MarkdownBlock | undefined): InlineStyle[] {
  if (!block || !("spans" in block)) {
    throw new Error(`block has no spans: ${block?.kind ?? "undefined"}`);
  }

  return block.spans;
}

describe("markdown blocks", () => {
  it("reads headings with their level", () => {
    const [heading] = parseMarkdown("## Results");
    expect(heading).toMatchObject({ kind: "heading", level: 2 });
    expect(spansToText(spansOf(heading))).toBe("Results");
  });

  it("reads bullet and ordered lists, including nesting depth", () => {
    const blocks = parseMarkdown("- one\n  - nested\n1. first\n2) second");
    expect(kinds(blocks)).toEqual(["listItem", "listItem", "listItem", "listItem"]);
    expect(blocks[1]).toMatchObject({ depth: 1, marker: "•" });
    expect(blocks[2]).toMatchObject({ depth: 0, marker: "1." });
    expect(blocks[3]).toMatchObject({ marker: "2." });
  });

  it("keeps fenced code verbatim and records its language", () => {
    const [block] = parseMarkdown("```ts\nconst x = 1;\n```");
    expect(block).toMatchObject({ kind: "code", language: "ts" });
    expect((block as { lines: string[] }).lines).toEqual(["const x = 1;"]);
  });

  it("closes an unterminated fence rather than losing the content", () => {
    const [block] = parseMarkdown("```python\nprint(1)\nprint(2)");
    expect((block as { lines: string[] }).lines).toEqual(["print(1)", "print(2)"]);
  });

  it("never treats markdown inside a fence as markdown", () => {
    const [block] = parseMarkdown("```\n# not a heading\n- not a list\n```");
    expect(block?.kind).toBe("code");
    expect((block as { lines: string[] }).lines).toEqual(["# not a heading", "- not a list"]);
  });

  it("reads quotes and horizontal rules", () => {
    expect(kinds(parseMarkdown("> quoted\n\n---"))).toEqual(["quote", "rule"]);
  });

  it("renders table rows as text and drops the divider", () => {
    const blocks = parseMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(kinds(blocks)).toEqual(["paragraph", "paragraph"]);
    expect(spansToText(spansOf(blocks[1]))).toBe("1  ·  2");
  });
});

describe("inline styles", () => {
  it("reads bold, italic, strikethrough and code", () => {
    expect(parseInline("**b**")).toEqual([{ text: "b", bold: true }]);
    expect(parseInline("*i*")).toEqual([{ text: "i", italic: true }]);
    expect(parseInline("~~s~~")).toEqual([{ text: "s", strike: true }]);
    expect(parseInline("`c`")).toEqual([{ text: "c", code: true }]);
  });

  it("lets code spans win, so paths and flags survive intact", () => {
    expect(parseInline("`a_b_c`")).toEqual([{ text: "a_b_c", code: true }]);
    expect(parseInline("`**not bold**`")).toEqual([{ text: "**not bold**", code: true }]);
  });

  it("leaves snake_case identifiers and glob stars alone", () => {
    expect(spansToText(parseInline("call read_file_now please"))).toBe("call read_file_now please");
    expect(parseInline("read_file_now").every((span) => !span.italic)).toBe(true);
    expect(spansToText(parseInline("src/**/*.ts"))).toBe("src/**/*.ts");
  });

  it("shows the label of a link, not its target", () => {
    expect(parseInline("[docs](https://example.com/x)")).toEqual([{ text: "docs", link: true }]);
  });

  it("marks a bare url as a link", () => {
    expect(parseInline("see https://example.com now")[1]).toMatchObject({ link: true });
  });

  it("nests emphasis", () => {
    expect(parseInline("**bold `code`**")).toEqual([
      { text: "bold ", bold: true },
      { text: "code", code: true, bold: true }
    ]);
  });

  it("passes plain text through untouched", () => {
    expect(spansToText(parseInline("nothing special here"))).toBe("nothing special here");
  });
});

describe("syntax highlighting", () => {
  it("maps the aliases models actually write", () => {
    expect(resolveLanguage("ts")).toBe("typescript");
    expect(resolveLanguage("JavaScript")).toBe("typescript");
    expect(resolveLanguage("py")).toBe("python");
    expect(resolveLanguage("bash")).toBe("shell");
    expect(resolveLanguage("brainfuck")).toBeNull();
  });

  it("returns one plain token for an unknown language", () => {
    expect(highlightLine("anything at all", "cobol")).toEqual([{ text: "anything at all", kind: "plain" }]);
    expect(highlightLine("anything at all", null)).toEqual([{ text: "anything at all", kind: "plain" }]);
  });

  it("marks keywords, strings, numbers and comments", () => {
    const tokens = highlightLine('const x = "hi"; // note', "ts");
    expect(tokens.find((token) => token.text === "const")?.kind).toBe("keyword");
    expect(tokens.find((token) => token.text === '"hi"')?.kind).toBe("string");
    expect(tokens.find((token) => token.text === "// note")?.kind).toBe("comment");
    expect(highlightLine("x = 42", "python").find((token) => token.text === "42")?.kind).toBe("number");
  });

  it("marks a name followed by a paren as a call", () => {
    expect(highlightLine("readFile(path)", "ts").find((token) => token.text === "readFile")?.kind).toBe("function");
  });

  it("does not end a string on an escaped quote", () => {
    const tokens = highlightLine('const s = "a\\"b";', "ts");
    expect(tokens.find((token) => token.kind === "string")?.text).toBe('"a\\"b"');
  });

  it("tolerates a string left open by a truncated stream", () => {
    const tokens = highlightLine('const s = "unterminated', "ts");
    expect(tokens.find((token) => token.kind === "string")?.text).toBe('"unterminated');
  });

  it("preserves the line exactly, whatever the tokens", () => {
    for (const line of ['const a = "x"; // c', "def f(x): return x", "if [ -f a ]; then echo 1; fi"]) {
      for (const language of ["ts", "python", "bash"]) {
        expect(highlightLine(line, language).map((token) => token.text).join("")).toBe(line);
      }
    }
  });
});

describe("diff rendering", () => {
  it("recognises diff fences", () => {
    expect(isDiffLanguage("diff")).toBe(true);
    expect(isDiffLanguage("patch")).toBe(true);
    expect(isDiffLanguage("ts")).toBe(false);
  });

  it("classifies each line of a patch", () => {
    expect(classifyDiffLine("+added")).toBe("added");
    expect(classifyDiffLine("-removed")).toBe("removed");
    expect(classifyDiffLine("@@ -1,2 +1,3 @@")).toBe("hunk");
    expect(classifyDiffLine("--- a/file.ts")).toBe("meta");
    expect(classifyDiffLine("+++ b/file.ts")).toBe("meta");
    expect(classifyDiffLine(" unchanged")).toBe("context");
  });

  it("reads file headers as metadata rather than additions", () => {
    expect(classifyDiffLine("+++ b/x")).not.toBe("added");
    expect(classifyDiffLine("--- a/x")).not.toBe("removed");
  });
});
