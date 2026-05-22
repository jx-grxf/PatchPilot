/**
 * Ultra-modes — power-mode keywords the user can drop **anywhere** in a prompt
 * (not only as a leading `/command`). Several can be combined in one prompt as
 * long as they do not conflict; an incompatible pair is reported so the TUI can
 * block the send instead of running a contradictory request.
 *
 *  - `ultramaxx`  — escalate: xhigh reasoning, large step budget, advisors on.
 *  - `ultracheap` — minimize: cheapest model, low reasoning, terse, advisors off.
 *  - `ultrafast`  — speed: lowest-latency settings, fixed short thinking, no advisors.
 *  - `ultrafocus` — restrict the agent to a single file/folder (`ultrafocus:path`).
 *  - `ultraloop`  — expand the run budget and require explicit self-verification
 *                   before the final answer.
 */
export type UltraMode = "maxx" | "cheap" | "fast" | "focus" | "loop";

export const ultraModeKeyword: Record<UltraMode, string> = {
  maxx: "ultramaxx",
  cheap: "ultracheap",
  fast: "ultrafast",
  focus: "ultrafocus",
  loop: "ultraloop",
};

/** All ultra keywords, longest first so matching is unambiguous. */
export const ultraKeywords: readonly string[] = Object.values(ultraModeKeyword);

/**
 * Pairs that must never run together. `maxx` and `cheap` sit on opposite ends
 * of the cost/effort axis — escalating and minimizing at the same time is
 * contradictory, so the prompt cannot be sent.
 */
const incompatiblePairs: ReadonlyArray<readonly [UltraMode, UltraMode]> = [
  ["maxx", "cheap"],
  ["maxx", "fast"],
];

export type UltraModeParse = {
  /** Distinct modes found, in detection order. */
  modes: UltraMode[];
  /** Optional path argument captured from `ultrafocus:<path>` / `ultrafocus <path>`. */
  focusPath: string | null;
  /** The prompt with every ultra keyword (and focus path) removed. */
  cleaned: string;
  /** Human-readable conflict message, or null when the combination is valid. */
  conflict: string | null;
};

// `ultrafocus` optionally swallows a following path token (`:path`, `=path`,
// or a bare path after whitespace). A quoted path keeps spaces intact.
const focusPattern = /\bultrafocus\b(?:\s*[:=]\s*|\s+)?("[^"]+"|'[^']+'|[^\s]+)?/i;
const plainKeywordPattern = (keyword: string): RegExp => new RegExp(`(?<![\\w-])${keyword}(?![\\w-])`, "ig");

/** True when the text contains any ultra keyword (anywhere, not just the start). */
export function hasUltraMode(text: string): boolean {
  return ultraKeywords.some((keyword) => plainKeywordPattern(keyword).test(text));
}

/**
 * Parse every ultra keyword out of a prompt, capture the focus path, strip the
 * keywords, and validate the combination.
 */
export function parseUltraModes(text: string): UltraModeParse {
  const modes: UltraMode[] = [];
  let cleaned = text;
  let focusPath: string | null = null;

  // `ultrafocus` first — it may carry a path argument that must be removed too.
  const focusMatch = cleaned.match(focusPattern);
  if (focusMatch) {
    modes.push("focus");
    const raw = focusMatch[1]?.trim() ?? "";
    focusPath = raw ? raw.replace(/^["']|["']$/g, "").trim() || null : null;
    cleaned = cleaned.replace(focusPattern, " ");
  }

  for (const mode of ["maxx", "cheap", "fast", "loop"] as const) {
    const pattern = plainKeywordPattern(ultraModeKeyword[mode]);
    if (pattern.test(cleaned)) {
      modes.push(mode);
      cleaned = cleaned.replace(plainKeywordPattern(ultraModeKeyword[mode]), " ");
    }
  }

  cleaned = cleaned.replace(/\s{2,}/g, " ").trim();

  let conflict: string | null = null;
  for (const [left, right] of incompatiblePairs) {
    if (modes.includes(left) && modes.includes(right)) {
      conflict = `${ultraModeKeyword[left]} and ${ultraModeKeyword[right]} cannot be combined — one escalates effort and cost, the other minimizes it. Keep only one.`;
      break;
    }
  }

  return { modes: orderModes(modes), focusPath, cleaned, conflict };
}

/** Stable display order regardless of where the keywords appeared. */
function orderModes(modes: UltraMode[]): UltraMode[] {
  const order: UltraMode[] = ["maxx", "cheap", "fast", "focus", "loop"];
  return order.filter((mode) => modes.includes(mode));
}

/** A short label like "ultramaxx + ultrafocus" for transcript messages. */
export function describeUltraModes(modes: UltraMode[]): string {
  return modes.map((mode) => ultraModeKeyword[mode]).join(" + ");
}

export type UltraSegment = {
  text: string;
  /** The ultra mode this segment spells out, or null for plain text. */
  mode: UltraMode | null;
};

const keywordToMode = new Map<string, UltraMode>(
  (Object.entries(ultraModeKeyword) as Array<[UltraMode, string]>).map(([mode, keyword]) => [keyword, mode]),
);
// One pass that finds any ultra keyword as a whole word, anywhere in the line.
const anyKeywordPattern = new RegExp(`(?<![\\w-])(${ultraKeywords.join("|")})(?![\\w-])`, "ig");

/**
 * Split a composer line into plain and ultra-keyword segments so each keyword
 * can be rendered with its own colour gradient — anywhere in the line.
 */
export function splitUltraSegments(line: string): UltraSegment[] {
  if (!line) {
    return [{ text: "", mode: null }];
  }

  const segments: UltraSegment[] = [];
  let lastIndex = 0;
  anyKeywordPattern.lastIndex = 0;
  for (let match = anyKeywordPattern.exec(line); match; match = anyKeywordPattern.exec(line)) {
    if (match.index > lastIndex) {
      segments.push({ text: line.slice(lastIndex, match.index), mode: null });
    }
    segments.push({ text: match[0], mode: keywordToMode.get(match[0].toLowerCase()) ?? null });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < line.length) {
    segments.push({ text: line.slice(lastIndex), mode: null });
  }

  return segments.length > 0 ? segments : [{ text: line, mode: null }];
}
