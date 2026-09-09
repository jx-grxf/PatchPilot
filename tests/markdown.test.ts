import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown, spansToText } from "../src/tui/markdown.js";
import { classifyDiffLine, looksLikeDiff, resolveLanguage } from "../src/tui/highlight.js";

const kinds = (source: string): string[] => parseMarkdown(source).map((block) => block.kind);

describe("block parsing", () => {
  it("recognises headings, lists, quotes and rules", () => {
    expect(kinds("# One")).toEqual(["heading"]);
    expect(kinds("- item")).toEqual(["bullet"]);
    expect(kinds("1. item")).toEqual(["ordered"]);
    expect(kinds("> quoted")).toEqual(["quote"]);
    expect(kinds("---")).toEqual(["rule"]);
  });

  it("caps heading depth at three, since a terminal has one font", () => {
    const levels = parseMarkdown("# a\n## b\n### c\n#### d\n##### e").map((block) =>
      block.kind === "heading" ? block.level : null
    );
    expect(levels).toEqual([1, 2, 3, 3, 3]);
  });

  it("tracks nesting depth on lists", () => {
    const blocks = parseMarkdown("- top\n  - nested\n    - deeper");
    const depths = blocks.map((block) => (block.kind === "bullet" ? block.depth : null));
    expect(depths).toEqual([0, 1, 2]);
  });

  it("keeps a fenced block intact and records its language", () => {
    const [block] = parseMarkdown("```ts\nconst x = 1;\nconst y = 2;\n```");
    expect(block).toMatchObject({ kind: "code", language: "ts", open: false });
    expect(block?.kind === "code" && block.lines).toEqual(["const x = 1;", "const y = 2;"]);
  });

  it("marks a fence that has not closed yet, so streaming code renders as code", () => {
    const [block] = parseMarkdown("```python\nprint('hi')");
    expect(block).toMatchObject({ kind: "code", language: "python", open: true });
  });

  it("never treats markdown inside a fence as markdown", () => {
    const [block] = parseMarkdown("```\n# not a heading\n- not a bullet\n```");
    expect(block?.kind === "code" && block.lines).toEqual(["# not a heading", "- not a bullet"]);
  });
});

describe("inline parsing", () => {
  const spans = (source: string) => parseInline(source);

  it("marks bold, italic, code and strikethrough", () => {
    expect(spans("**b**")[0]).toMatchObject({ text: "b", bold: true });
    expect(spans("*i*")[0]).toMatchObject({ text: "i", italic: true });
    expect(spans("`c`")[0]).toMatchObject({ text: "c", code: true });
    expect(spans("~~s~~")[0]).toMatchObject({ text: "s", strike: true });
  });

  it("nests emphasis but keeps code spans literal", () => {
    expect(spans("**bold with *italic* inside**").some((span) => span.bold && span.italic)).toBe(true);
    expect(spans("`**not bold**`")[0]).toMatchObject({ text: "**not bold**", code: true });
  });

  it("leaves an unclosed marker as literal text, which is the normal streaming state", () => {
    expect(spansToText(spans("**half written"))).toBe("**half written");
    expect(spansToText(spans("a `code fence that never"))).toBe("a `code fence that never");
  });

  it("does not eat the stars out of a glob", () => {
    expect(spansToText(spans("Files under src/**/*.ts changed."))).toBe("Files under src/**/*.ts changed.");
    expect(spansToText(spans("run **/*.test.ts"))).toBe("run **/*.test.ts");
  });

  it("leaves arithmetic and snake_case alone", () => {
    expect(spansToText(spans("2 * 3 * 4"))).toBe("2 * 3 * 4");
    expect(spansToText(spans("some_var_name and other_name"))).toBe("some_var_name and other_name");
  });

  it("renders a link by its label and keeps the target", () => {
    expect(spans("[docs](https://example.com)")[0]).toMatchObject({ text: "docs", href: "https://example.com" });
  });

  it("falls back to the URL when a link has no label", () => {
    expect(spans("[](https://example.com)")[0]).toMatchObject({ text: "https://example.com" });
  });

  it("honours a backslash escape", () => {
    expect(spansToText(spans("\\*not italic\\*"))).toBe("*not italic*");
  });
});

describe("language resolution", () => {
  it("maps the aliases a fence actually carries", () => {
    expect(resolveLanguage("ts")).toBe("typescript");
    expect(resolveLanguage("py")).toBe("python");
    expect(resolveLanguage("sh")).toBe("bash");
    expect(resolveLanguage("golang")).toBe("go");
  });

  it("passes an unknown name straight through rather than guessing", () => {
    expect(resolveLanguage("elixir")).toBe("elixir");
    expect(resolveLanguage("")).toBeUndefined();
  });
});

describe("diff classification", () => {
  it("separates additions, removals, headers and context", () => {
    expect(classifyDiffLine("+added")).toBe("added");
    expect(classifyDiffLine("-removed")).toBe("removed");
    expect(classifyDiffLine("@@ -1,2 +1,5 @@")).toBe("header");
    expect(classifyDiffLine("--- a/file.ts")).toBe("header");
    expect(classifyDiffLine(" unchanged")).toBe("context");
  });

  it("recognises a unified diff so it is not parsed as markdown", () => {
    expect(looksLikeDiff("@@ -1,2 +1,5 @@\n context\n+added")).toBe(true);
    expect(looksLikeDiff("diff --git a/x b/x\nindex 1..2")).toBe(true);
    expect(looksLikeDiff("Just prose with a - dash")).toBe(false);
  });
});
