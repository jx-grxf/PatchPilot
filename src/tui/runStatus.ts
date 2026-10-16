import type { AgentWorkState } from "../core/types.js";
import type { StreamProgress } from "./transcriptEvents.js";

/**
 * A star that grows and settles rather than a wheel that spins: it reads as
 * activity without pulling the eye the way a fast rotation does.
 */
export const spinnerGlyphs = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];

/** Spinner cadence in ms. */
export const spinnerFrameMs = 110;

/** Gradient animation cadence for ultra keywords, in ms. */
export const waveFrameMs = 110;

/** Pick the braille glyph for the given frame counter. */
export function spinnerGlyph(frame: number): string {
  const safe = Number.isFinite(frame) ? Math.abs(Math.trunc(frame)) : 0;
  return spinnerGlyphs[safe % spinnerGlyphs.length] ?? spinnerGlyphs[0]!;
}

export type RunActivity = {
  /** What is happening, in one or two words. */
  label: string;
  /** Supporting figures, or an explanation when the wait is unusual. */
  detail: string;
};

const workStateLabels: Record<AgentWorkState, string> = {
  idle: "Starting",
  inspecting: "Inspecting",
  planning: "Planning",
  reading: "Reading files",
  editing: "Editing files",
  verifying: "Running commands",
  waiting_approval: "Waiting for approval",
  done: "Finishing",
  error: "Recovering"
};

/**
 * The run line names what is actually happening rather than a rotating verb:
 * a user waiting five minutes needs to know whether the model is reading,
 * writing, or blocked on the server.
 */
export function describeRunActivity(workState: AgentWorkState, progress: StreamProgress | null, status = ""): RunActivity {
  if (!progress) {
    const detail = status.trim();
    return { label: workStateLabels[workState], detail: detail && !["idle", "starting"].includes(detail) ? detail : "" };
  }

  if (progress.phase === "prompt") {
    return { label: "Reading prompt", detail: "" };
  }

  if (progress.writing) {
    const label = `Writing ${progress.writing.tool}`;
    // Most local servers parse a tool call out of the token stream and only
    // send its arguments once the call is complete. Without saying so, a long
    // file write looks exactly like a hang.
    return progress.writing.chars === 0
      ? { label, detail: "server sends the arguments when the call is complete" }
      : { label, detail: `${formatCount(progress.writing.chars)} chars` };
  }

  // Generating with no visible tokens yet means the model is reasoning.
  return progress.tokens > 0 ? { label: "Generating", detail: `${formatCount(progress.tokens)} tok` } : { label: "Thinking", detail: "" };
}

/** Format elapsed milliseconds as a compact human duration for the status line. */
export function formatElapsed(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return "0s";
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

export type RunOutcome = "done" | "failed" | "stopped";

/** The closing line of a run: how it ended and how long it took. */
export function formatCompletionSummary(elapsedMs: number, outcome: RunOutcome): string {
  const duration = formatRunDuration(elapsedMs);
  switch (outcome) {
    case "done":
      return `Done in ${duration}`;
    case "failed":
      return `Failed after ${duration}`;
    case "stopped":
      return `Stopped after ${duration}`;
  }
}

function formatCount(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k` : String(value);
}
