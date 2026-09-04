import React from "react";
import { Box, Text } from "ink";
import { classifyDiffLine, highlightLine, isDiffLanguage, type Token, type TokenKind } from "../highlight.js";
import { parseMarkdown, type InlineStyle, type MarkdownBlock } from "../markdown.js";

/**
 * Renders Markdown into Ink nodes.
 *
 * Colours are chosen to survive both light and dark terminals: no bright
 * whites or near-blacks, and every distinction is carried by weight or symbol
 * as well as hue, so the output still reads with colour disabled.
 */

const tokenColor: Record<TokenKind, string | undefined> = {
  plain: undefined,
  keyword: "magenta",
  string: "green",
  comment: "gray",
  number: "yellow",
  function: "cyan",
  punctuation: "gray"
};

const headingColor = ["cyan", "cyan", "blue", "blue", "gray", "gray"] as const;

export function Markdown(props: { source: string; dimmed?: boolean }): React.ReactElement {
  const blocks = parseMarkdown(props.source);

  return (
    <Box flexDirection="column">
      {blocks.map((block, index) => (
        <MarkdownBlockView key={index} block={block} dimmed={props.dimmed} />
      ))}
    </Box>
  );
}

function MarkdownBlockView(props: { block: MarkdownBlock; dimmed?: boolean }): React.ReactElement | null {
  const { block } = props;

  switch (block.kind) {
    case "blank":
      return <Text> </Text>;

    case "rule":
      return <Text color="gray">────────────────────</Text>;

    case "heading":
      return (
        <Text bold color={headingColor[Math.min(block.level, headingColor.length) - 1]}>
          {block.level <= 2 ? "" : "› "}
          <Spans spans={block.spans} dimmed={props.dimmed} />
        </Text>
      );

    case "listItem":
      return (
        <Text>
          <Text color="gray">
            {"  ".repeat(block.depth + 1)}
            {block.marker}{" "}
          </Text>
          <Spans spans={block.spans} dimmed={props.dimmed} />
        </Text>
      );

    case "quote":
      return (
        <Text color="gray">
          {"▏ "}
          <Spans spans={block.spans} dimmed />
        </Text>
      );

    case "code":
      return <CodeBlock language={block.language} lines={block.lines} />;

    case "paragraph":
      return (
        <Text>
          <Spans spans={block.spans} dimmed={props.dimmed} />
        </Text>
      );
  }
}

function Spans(props: { spans: InlineStyle[]; dimmed?: boolean }): React.ReactElement {
  return (
    <>
      {props.spans.map((span, index) => {
        if (span.code) {
          // Padding a code span reads as inline code without a background,
          // which terminals render inconsistently.
          return (
            <Text key={index} color="yellow">
              {span.text}
            </Text>
          );
        }

        return (
          <Text
            key={index}
            bold={span.bold}
            italic={span.italic}
            strikethrough={span.strike}
            underline={span.link}
            color={span.link ? "blue" : props.dimmed ? "gray" : undefined}
          >
            {span.text}
          </Text>
        );
      })}
    </>
  );
}

/**
 * A fenced block. Diffs get per-line +/- colouring; everything else gets
 * token highlighting, and an unknown language renders as plain text rather
 * than guessing.
 */
function CodeBlock(props: { language: string | null; lines: string[] }): React.ReactElement {
  const diff = isDiffLanguage(props.language);

  return (
    <Box flexDirection="column" paddingLeft={1}>
      {props.lines.map((line, index) =>
        diff ? <DiffLine key={index} line={line} /> : <CodeLine key={index} line={line} language={props.language} />
      )}
    </Box>
  );
}

function CodeLine(props: { line: string; language: string | null }): React.ReactElement {
  const tokens = highlightLine(props.line, props.language);
  return (
    <Text>
      <Text color="gray">│ </Text>
      {tokens.map((token: Token, index: number) => (
        <Text key={index} color={tokenColor[token.kind]}>
          {token.text}
        </Text>
      ))}
    </Text>
  );
}

function DiffLine(props: { line: string }): React.ReactElement {
  const kind = classifyDiffLine(props.line);
  const color = kind === "added" ? "green" : kind === "removed" ? "red" : kind === "hunk" ? "cyan" : kind === "meta" ? "gray" : undefined;
  // The sign is kept so the diff still reads when colour is unavailable.
  return (
    <Text color={color} dimColor={kind === "meta"}>
      {props.line || " "}
    </Text>
  );
}
