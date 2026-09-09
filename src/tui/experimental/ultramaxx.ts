/**
 * `ultramaxx` is a power-mode prefix: starting a prompt with it makes the
 * backend think and work extra hard for that run (thinking enabled, a larger
 * step budget, child agents, and mandatory planning).
 */
export const ultramaxxKeyword = "ultramaxx";

const ultramaxxActivationPattern = /^\s*(?:[/!#]ultramaxx|ultramaxx)(?=$|[\s:.-])/i;
const ultramaxxStripPattern = /^\s*(?:[/!#]ultramaxx|ultramaxx)(?=$|[\s:.-])(?:\s*[:.-]\s*|\s+)?/i;
const ultramaxxTokenAtStartPattern = /^(\s*(?:[/!#])?)(ultramaxx)(?=$|[\s:.-])/i;

/** True when the text starts with an explicit ultramaxx activator. */
export function hasUltramaxx(text: string): boolean {
  return ultramaxxActivationPattern.test(text);
}

/** Remove the ultramaxx activator from the task text before it reaches the model. */
export function stripUltramaxx(text: string): string {
  return text.replace(ultramaxxStripPattern, "").replace(/\s{2,}/g, " ").trim();
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

  const match = line.match(ultramaxxTokenAtStartPattern);
  if (!match || match.index !== 0) {
    return [{ text: line, ultramaxx: false }];
  }

  const prefix = match[1] ?? "";
  const token = match[2] ?? ultramaxxKeyword;
  const segments: TextSegment[] = [];
  if (prefix) {
    segments.push({ text: prefix, ultramaxx: false });
  }
  segments.push({ text: token, ultramaxx: true });
  const rest = line.slice(prefix.length + token.length);
  if (rest) {
    segments.push({ text: rest, ultramaxx: false });
  }
  return segments;
}
