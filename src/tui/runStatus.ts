import type { AgentWorkState } from "../core/types.js";

/**
 * Run-status verbs. The spinner glyph animates fast; the verb must stay stable
 * and only rotate on a slow cadence so the status line does not flicker
 * semantically several times per second.
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
  "Forming",
  "Generating",
  "Hashing",
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

/** Braille spinner glyphs — the classic fast loading animation. */
export const spinnerGlyphs = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Fast spinner glyph cadence in ms. */
export const spinnerFrameMs = 90;

/** The verb only changes once every this many ms. */
export const verbCycleMs = 10_000;

/** Pick the fast-animating braille glyph for the given frame counter. */
export function spinnerGlyph(frame: number): string {
  const safe = Number.isFinite(frame) ? Math.abs(Math.trunc(frame)) : 0;
  return spinnerGlyphs[safe % spinnerGlyphs.length] ?? spinnerGlyphs[0]!;
}

/**
 * Pick the run-status verb for the given elapsed time. The verb is stable for
 * `verbCycleMs` and then advances by one — never tied to the fast spinner.
 */
export function runStatusVerb(elapsedMs: number, seed = 0): string {
  const safeElapsed = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  const tick = Math.floor(safeElapsed / verbCycleMs);
  const safeSeed = Number.isFinite(seed) ? Math.abs(Math.trunc(seed)) : 0;
  const index = (tick + safeSeed) % runStatusVerbs.length;
  return runStatusVerbs[index] ?? runStatusVerbs[0]!;
}

/**
 * Build the semantic run-status line: a stable verb plus the work state and an
 * optional detail. The verb is derived from elapsed time, not the spinner
 * frame, so it only changes every 10s.
 */
export function formatRunStatus(options: {
  workState: AgentWorkState;
  status: string;
  elapsedMs: number;
  seed?: number;
}): string {
  const verb = runStatusVerb(options.elapsedMs, options.seed);
  const state = options.workState.replace(/_/g, " ");
  const trimmedStatus = options.status?.trim() ?? "";
  const detail = trimmedStatus && trimmedStatus !== state ? `: ${trimmedStatus}` : "";
  return `${verb} ${state}${detail}`;
}

/** Format elapsed milliseconds as a compact human duration for the status line. */
export function formatElapsed(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return "starting";
  }

  const totalSeconds = Math.floor(elapsedMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}
