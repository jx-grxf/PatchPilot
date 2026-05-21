import type { AgentWorkState } from "../core/types.js";

/**
 * Run-status verbs. The spinner glyph animates fast; the verb stays stable and
 * only rotates on a slow cadence, and it advances in a pseudo-random order so
 * it never feels like a fixed list cycling.
 */
export const runStatusVerbs: string[] = [
  "Accomplishing",
  "Actioning",
  "Architecting",
  "Baking",
  "Bootstrapping",
  "Brewing",
  "Calculating",
  "Cascading",
  "Channeling",
  "Composing",
  "Computing",
  "Concocting",
  "Considering",
  "Contemplating",
  "Cooking",
  "Crafting",
  "Creating",
  "Crunching",
  "Crystallizing",
  "Deciphering",
  "Deliberating",
  "Determining",
  "Distilling",
  "Elucidating",
  "Envisioning",
  "Forging",
  "Generating",
  "Hatching",
  "Ideating",
  "Imagining",
  "Improvising",
  "Incubating",
  "Inferring",
  "Inspecting",
  "Manifesting",
  "Mulling",
  "Musing",
  "Orchestrating",
  "Percolating",
  "Pondering",
  "Processing",
  "Puzzling",
  "Reasoning",
  "Reticulating",
  "Reviewing",
  "Ruminating",
  "Sketching",
  "Spelunking",
  "Synthesizing",
  "Tinkering",
  "Transmuting",
  "Unravelling",
  "Wrangling",
];

/** Past-tense verbs for the run-completion summary ("Crunched for 17m 58s"). */
export const completionVerbs: string[] = [
  "Crunched",
  "Cooked",
  "Brewed",
  "Forged",
  "Hammered",
  "Conjured",
  "Distilled",
  "Wrangled",
  "Orchestrated",
  "Synthesized",
  "Composed",
  "Architected",
  "Tinkered",
  "Pondered",
  "Crafted",
  "Spelunked",
];

/** Braille spinner glyphs — the classic fast loading animation. */
export const spinnerGlyphs = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Pulsing accent glyphs used for completion / decorative markers. */
export const pulseGlyphs = ["✻", "✺", "✷", "✶", "✦", "✶", "✷", "✺"];

/** Fast spinner glyph cadence in ms. */
export const spinnerFrameMs = 90;

/** Wave / highlight animation cadence in ms. */
export const waveFrameMs = 110;

/** The verb only changes once every this many ms. */
export const verbCycleMs = 10_000;

/** Small deterministic hash so verb order is pseudo-random, not sequential. */
function hashTick(tick: number, seed: number): number {
  let value = (Math.trunc(tick) * 2654435761 + Math.trunc(seed) * 40503 + 0x9e3779b9) >>> 0;
  value ^= value >>> 15;
  value = (value * 0x85ebca6b) >>> 0;
  value ^= value >>> 13;
  return value >>> 0;
}

/** Pick the fast-animating braille glyph for the given frame counter. */
export function spinnerGlyph(frame: number): string {
  const safe = Number.isFinite(frame) ? Math.abs(Math.trunc(frame)) : 0;
  return spinnerGlyphs[safe % spinnerGlyphs.length] ?? spinnerGlyphs[0]!;
}

/** Pick a pulsing accent glyph for the given frame counter. */
export function pulseGlyph(frame: number): string {
  const safe = Number.isFinite(frame) ? Math.abs(Math.trunc(frame)) : 0;
  return pulseGlyphs[safe % pulseGlyphs.length] ?? pulseGlyphs[0]!;
}

/**
 * Pick the run-status verb for the given elapsed time. The verb is stable for
 * `verbCycleMs`, then jumps to a pseudo-random next verb (never a fixed cycle).
 */
export function runStatusVerb(elapsedMs: number, seed = 0): string {
  const safeElapsed = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  const tick = Math.floor(safeElapsed / verbCycleMs);
  const index = hashTick(tick, seed) % runStatusVerbs.length;
  return runStatusVerbs[index] ?? runStatusVerbs[0]!;
}

export type RunStatusParts = {
  verb: string;
  state: string;
  detail: string;
};

/**
 * Split the run status into its parts so the UI can animate the verb on its
 * own and render the (stable) state/detail separately with clear spacing.
 */
export function runStatusParts(options: {
  workState: AgentWorkState;
  status: string;
  elapsedMs: number;
  seed?: number;
}): RunStatusParts {
  const verb = runStatusVerb(options.elapsedMs, options.seed);
  const state = options.workState.replace(/_/g, " ");
  const trimmedStatus = options.status?.trim() ?? "";
  const detail = trimmedStatus && trimmedStatus !== state ? trimmedStatus : "";
  return { verb, state, detail };
}

/** Format elapsed milliseconds as a compact human duration for the status line. */
export function formatElapsed(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return "starting";
  }

  return formatRunDuration(elapsedMs);
}

/** Format a run duration like "4s" or "17m 58s". */
export function formatRunDuration(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor((Number.isFinite(elapsedMs) ? elapsedMs : 0) / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }

  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Build a run-completion summary like "Crunched for 17m 58s". */
export function formatCompletionSummary(elapsedMs: number, seed = 0): string {
  const verb = completionVerbs[hashTick(0, seed + 7) % completionVerbs.length] ?? completionVerbs[0]!;
  return `${verb} for ${formatRunDuration(elapsedMs)}`;
}
