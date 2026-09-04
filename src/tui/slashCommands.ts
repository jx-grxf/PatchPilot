import type { CommandSuggestionItem } from "./components/CommandSuggestions.js";

/** A palette row: what it shows, what it runs, and whether Enter runs it. */
export type PaletteSuggestion = CommandSuggestionItem & {
  command: string;
  execute: boolean;
};

/**
 * What pressing Enter on a slash command should do.
 *
 * This used to be five interacting conditions at the call site, and the result
 * was that some commands ran on Enter while others only filled the input and
 * had to be submitted a second time — with no way to tell which from looking
 * at them. The rule is now one sentence: a command that still needs an
 * argument gets completed, everything else runs.
 */

export type SlashSubmission =
  | { action: "run"; command: string }
  /** Put this in the composer and wait; the user still has to say what to act on. */
  | { action: "complete"; input: string };

/** A usage string with <required> or [optional] placeholders needs an argument. */
export function needsArgument(usage: string): boolean {
  return usage.includes("<") || usage.includes("[");
}

/** True once the input carries something after the command name. */
export function hasArgument(input: string): boolean {
  return /^\/\S+\s+\S/.test(input.trim());
}

export function resolveSlashSubmission(
  input: string,
  suggestions: PaletteSuggestion[],
  selectedIndex: number
): SlashSubmission {
  const typed = input.trim();
  const selected = suggestions[selectedIndex];

  // Nothing highlighted: run exactly what was typed. A command the user spelled
  // out in full should never be second-guessed.
  if (!selected) {
    return { action: "run", command: typed };
  }

  // A suggestion that supplies the whole invocation — a host URL, a model id —
  // is a choice, not a prefix, so selecting it runs it.
  if (selected.execute) {
    return { action: "run", command: selected.command };
  }

  // The suggestion is a bare command that still wants an argument. If the user
  // already typed one, honour what they typed rather than truncating it.
  if (hasArgument(typed)) {
    return { action: "run", command: typed };
  }

  return { action: "complete", input: `${selected.command} ` };
}

/**
 * The hint shown next to a suggestion. It has to match what Enter will
 * actually do, or the list teaches the wrong thing.
 */
export function suggestionHint(suggestion: PaletteSuggestion): "run" | "fill" {
  return suggestion.execute ? "run" : "fill";
}
