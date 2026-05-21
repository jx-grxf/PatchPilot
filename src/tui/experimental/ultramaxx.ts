/**
 * `ultramaxx` is a power-mode keyword: typing it anywhere in the prompt makes
 * the backend think and work extra hard for that run (escalated reasoning
 * effort, a larger step budget, advisor subagents, mandatory planning).
 */
export const ultramaxxKeyword = "ultramaxx";

const ultramaxxPattern = /\bultramaxx\b/i;
const ultramaxxGlobalPattern = /\bultramaxx\b/gi;

/** True when the text contains the ultramaxx keyword as a standalone word. */
export function hasUltramaxx(text: string): boolean {
  return ultramaxxPattern.test(text);
}

/** Remove the ultramaxx keyword from the task text before it reaches the model. */
export function stripUltramaxx(text: string): string {
  return text.replace(ultramaxxGlobalPattern, "").replace(/\s{2,}/g, " ").trim();
}

export type TextSegment = {
  text: string;
  ultramaxx: boolean;
};

/**
 * Split a line into plain and `ultramaxx` segments so the composer can render
 * the keyword with the rainbow animation while leaving the rest untouched.
 */
export function splitUltramaxxSegments(line: string): TextSegment[] {
  if (!line) {
    return [{ text: "", ultramaxx: false }];
  }

  const segments: TextSegment[] = [];
  let lastIndex = 0;
  for (const match of line.matchAll(ultramaxxGlobalPattern)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      segments.push({ text: line.slice(lastIndex, start), ultramaxx: false });
    }
    segments.push({ text: match[0], ultramaxx: true });
    lastIndex = start + match[0].length;
  }

  if (lastIndex < line.length) {
    segments.push({ text: line.slice(lastIndex), ultramaxx: false });
  }

  return segments.length > 0 ? segments : [{ text: line, ultramaxx: false }];
}
