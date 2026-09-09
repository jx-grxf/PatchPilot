/**
 * Motion and small graphics for the terminal.
 *
 * A terminal cell is the smallest thing you can colour, which makes most
 * progress bars jump a whole character at a time. The Unicode block elements
 * subdivide a cell into eighths, so a bar can move eight times more smoothly
 * for free — that single trick is most of the difference between a bar that
 * looks mechanical and one that looks considered.
 *
 * Everything here is a pure function of a frame counter, so a component only
 * has to hold an integer that increments, and nothing needs a timer of its own.
 */

/** Eighth-width blocks, from empty to full. The heart of the smooth bar. */
const partialBlocks = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"] as const;

/** Braille dots animate more smoothly than the ASCII spinner most tools use. */
const brailleSpinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** A slower, quieter pulse for states that are waiting rather than working. */
const pulseFrames = ["·", "∙", "●", "∙"] as const;

/** Frames per second the shell renders at; every duration below assumes it. */
export const frameIntervalMs = 80;

export function spinnerFrame(frame: number): string {
  return brailleSpinner[frame % brailleSpinner.length] ?? "⠋";
}

export function pulseFrame(frame: number): string {
  return pulseFrames[Math.floor(frame / 3) % pulseFrames.length] ?? "·";
}

/**
 * A bar that fills in eighths rather than whole cells.
 *
 * `width` is the cell count, so the effective resolution is width × 8. The
 * partial cell is what sells the motion: without it a 10-cell bar has ten
 * states, with it eighty.
 */
export function smoothBar(ratio: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const eighths = Math.round(clamped * width * 8);
  const fullCells = Math.floor(eighths / 8);
  const remainder = eighths % 8;

  const filled = "█".repeat(Math.min(width, fullCells));
  const partial = fullCells < width ? partialBlocks[remainder] ?? "" : "";
  const empty = " ".repeat(Math.max(0, width - fullCells - (partial ? 1 : 0)));

  return `${filled}${partial}${empty}`;
}

/**
 * A bar with a visible track, for meters that should read as full-width even
 * when nearly empty — a context meter at 3% still needs to show its extent.
 */
export function trackedBar(ratio: number, width: number): string {
  const bar = smoothBar(ratio, width);
  return bar.replace(/ /g, "░");
}

/** Eight heights for a sparkline, matching the bar's eighth resolution. */
const sparkLevels = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

/**
 * A sparkline over recent samples, scaled to its own maximum.
 *
 * Scaling to the window rather than to an absolute ceiling is deliberate: the
 * question a throughput sparkline answers is "is this speeding up or slowing
 * down", which an absolute scale flattens into a line near the floor.
 */
export function sparkline(samples: number[], width: number): string {
  if (samples.length === 0) {
    return " ".repeat(width);
  }

  const window = samples.slice(-width);
  const peak = Math.max(...window, 1);
  const rendered = window
    .map((sample) => {
      const level = Math.round((Math.max(0, sample) / peak) * (sparkLevels.length - 1));
      return sparkLevels[level] ?? sparkLevels[0];
    })
    .join("");

  return rendered.padStart(width, " ");
}

/**
 * A travelling highlight for a word that is being worked on.
 *
 * Returns the index of the character to brighten, or -1 between passes. The
 * gap matters: a shimmer that never rests reads as a glitch, one that sweeps
 * and pauses reads as a heartbeat.
 */
export function shimmerIndex(frame: number, length: number): number {
  if (length === 0) {
    return -1;
  }

  const cycle = length + 6;
  const position = frame % cycle;
  return position < length ? position : -1;
}

/**
 * Ease-in-out over 0..1. Used for anything that grows or shrinks, so it
 * accelerates away from rest and settles rather than moving at a constant rate.
 */
export function easeInOut(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return clamped < 0.5 ? 2 * clamped * clamped : 1 - (-2 * clamped + 2) ** 2 / 2;
}

/** Colour for a meter, by how much room is left rather than by how full it is. */
export function pressureColor(ratio: number): "green" | "cyan" | "yellow" | "red" {
  if (ratio >= 1) {
    return "red";
  }
  if (ratio >= 0.85) {
    return "yellow";
  }
  if (ratio >= 0.7) {
    return "cyan";
  }

  return "green";
}

/**
 * Elapsed time, at the precision a person actually reads. Sub-second decimals
 * matter for a fast call and are noise for a slow one.
 */
export function formatElapsed(elapsedMs: number): string {
  const seconds = elapsedMs / 1000;
  if (seconds < 10) {
    return `${seconds.toFixed(1)}s`;
  }
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }

  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(Math.round(seconds % 60)).padStart(2, "0")}s`;
}

/** Compact token counts: 9.1k reads faster than 9100 in a status line. */
export function formatCompact(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 10_000) {
    return `${Math.round(value / 1000)}k`;
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}k`;
  }

  return String(Math.round(value));
}

/**
 * Whether motion should run at all. A terminal that is not a TTY is being
 * piped or recorded, where an animation becomes thousands of redundant frames.
 */
export function motionEnabled(env: NodeJS.ProcessEnv = process.env, isTty = process.stdout.isTTY): boolean {
  if (env.PATCHPILOT_REDUCE_MOTION && env.PATCHPILOT_REDUCE_MOTION !== "0") {
    return false;
  }

  return Boolean(isTty);
}
