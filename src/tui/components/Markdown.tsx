import React from "react";
import { Box, Text } from "ink";
import { classifyDiffLine, highlightBlock, looksLikeDiff, resolveLanguage } from "../highlight.js";
import { parseMarkdown, type InlineSpan, type MarkdownBlock } from "../markdown.js";

/**
 * Renders assistant output as markdown.
 *
 * A terminal has one font, so hierarchy has to come from weight, colour,
 * indentation and glyphs. Every distinction here is carried by at least two of
 * those — a heading is bold *and* coloured, a diff line keeps its +/- as well
 * as its colour — so the output still reads on a monochrome terminal and in a
 * piped log.
 */

export function Markdown(props: { text: string; width: number; dim?: boolean }): React.ReactElement {
  // A raw diff is not markdown and must not be parsed as one: its leading -
  // would become bullet points and its +++ a heading.
  if (looksLikeDiff(props.text)) {
    return <DiffBlock lines={props.text.split("\n")} width={props.width} />;
  }

  const blocks = parseMarkdown(props.text);
  return (
    <Box flexDirection="column">
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} width={props.width} dim={props.dim} previous={blocks[index - 1]} />
      ))}
    </Box>
  );
}

function BlockView(props: {
  block: MarkdownBlock;
  width: number;
  dim?: boolean;
  previous?: MarkdownBlock;
}): React.ReactElement | null {
  const { block } = props;

  switch (block.kind) {
    case "blank":
      // Collapse runs of blank lines: a stream often carries several, and each
      // one costs a row of a terminal that has forty.
      return props.previous?.kind === "blank" ? null : <Text> </Text>;

    case "rule":
      return <Text color="gray">{"─".repeat(Math.max(4, Math.min(props.width, 60)))}</Text>;

    case "heading":
      return (
        <Box marginTop={block.level === 1 ? 1 : 0}>
          <Text bold color={block.level === 1 ? "cyan" : block.level === 2 ? "white" : "gray"}>
            {block.level === 1 ? "" : block.level === 2 ? "" : ""}
            <Spans spans={block.spans} />
          </Text>
        </Box>
      );

    case "quote":
      return (
        <Box>
          <Text color="gray">{"│ "}</Text>
          <Text color="gray" italic>
            <Spans spans={block.spans} />
          </Text>
        </Box>
      );

    case "bullet":
      return (
        <Box>
          <Text color="gray">
            {"  ".repeat(block.depth)}
            {bulletGlyph(block.depth)}{" "}
          </Text>
          <Box flexGrow={1}>
            <Text dimColor={props.dim} wrap="wrap">
              <Spans spans={block.spans} />
            </Text>
          </Box>
        </Box>
      );

    case "ordered":
      return (
        <Box>
          <Text color="gray">
            {"  ".repeat(block.depth)}
            {block.marker}.{" "}
          </Text>
          <Box flexGrow={1}>
            <Text dimColor={props.dim} wrap="wrap">
              <Spans spans={block.spans} />
            </Text>
          </Box>
        </Box>
      );

    case "code":
      return <CodeBlock language={block.language} lines={block.lines} width={props.width} open={block.open} />;

    case "paragraph":
      return (
        <Text dimColor={props.dim} wrap="wrap">
          <Spans spans={block.spans} />
        </Text>
      );
  }
}

/** Nesting depth is carried by the glyph as well as the indent. */
function bulletGlyph(depth: number): string {
  return depth === 0 ? "•" : depth === 1 ? "◦" : "▪";
}

function Spans(props: { spans: InlineSpan[] }): React.ReactElement {
  return (
    <>
      {props.spans.map((span, index) => {
        if (span.code) {
          return (
            <Text key={index} color="yellow">
              {span.text}
            </Text>
          );
        }

        if (span.href) {
          return (
            <Text key={index} color="cyan" underline>
              {span.text}
            </Text>
          );
        }

        return (
          <Text key={index} bold={span.bold} italic={span.italic} strikethrough={span.strike}>
            {span.text}
          </Text>
        );
      })}
    </>
  );
}

function CodeBlock(props: { language: string; lines: string[]; width: number; open: boolean }): React.ReactElement {
  const language = resolveLanguage(props.language);
  const highlighted = highlightBlock(props.lines.join("\n"), language);

  return (
    <Box flexDirection="column" marginY={1}>
      {props.language ? (
        <Text color="gray" dimColor>
          {"  "}
          {props.language}
          {props.open ? " ·" : ""}
        </Text>
      ) : null}
      {highlighted.map((line, index) => (
        <Box key={index}>
          <Text color="gray">{"  │ "}</Text>
          <Text wrap="truncate">{line}</Text>
        </Box>
      ))}
    </Box>
  );
}

/**
 * Renders a unified diff. Added and removed lines keep their +/- so the
 * distinction survives without colour, and each line is highlighted as code
 * once its marker is stripped.
 */
export function DiffBlock(props: { lines: string[]; width: number; language?: string }): React.ReactElement {
  const language = props.language ? resolveLanguage(props.language) : undefined;

  return (
    <Box flexDirection="column">
      {props.lines.map((line, index) => {
        const kind = classifyDiffLine(line);
        if (kind === "header") {
          return (
            <Text key={index} color="gray" dimColor>
              {"  "}
              {line}
            </Text>
          );
        }

        const marker = kind === "added" ? "+" : kind === "removed" ? "-" : " ";
        const body = kind === "context" ? line : line.slice(1);
        const [highlightedBody] = highlightBlock(body, language);

        return (
          <Box key={index}>
            <Text color={kind === "added" ? "green" : kind === "removed" ? "red" : "gray"} bold={kind !== "context"}>
              {"  "}
              {marker}
              {" "}
            </Text>
            <Text
              color={kind === "added" ? "green" : kind === "removed" ? "red" : undefined}
              dimColor={kind === "context"}
              wrap="truncate"
            >
              {highlightedBody ?? body}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
