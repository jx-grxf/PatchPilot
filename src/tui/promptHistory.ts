/**
 * Recall of previously submitted prompts, the way every shell has done it
 * since readline.
 *
 * The rules that make it feel right rather than merely present: an unsent
 * draft is preserved when you arrow away from it and restored when you arrow
 * back past the newest entry, consecutive duplicates are not stored, and
 * navigation only starts when the caret is on the first line — otherwise Up
 * has to keep meaning "move the caret" inside a multi-line prompt.
 */

export type PromptHistory = {
  entries: string[];
  /** null when editing a fresh draft rather than browsing. */
  index: number | null;
  /** The draft set aside while browsing. */
  draft: string;
};

/** How many prompts are kept. Enough to reach this morning's work. */
export const maxPromptHistory = 200;

export function emptyPromptHistory(): PromptHistory {
  return { entries: [], index: null, draft: "" };
}

export function rememberPrompt(history: PromptHistory, prompt: string): PromptHistory {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return { ...history, index: null, draft: "" };
  }

  // Re-running the same prompt twice should not fill the history with it.
  const entries = history.entries[history.entries.length - 1] === trimmed
    ? history.entries
    : [...history.entries, trimmed].slice(-maxPromptHistory);

  return { entries, index: null, draft: "" };
}

export type HistoryStep = {
  history: PromptHistory;
  /** The text the composer should show, or null to leave it untouched. */
  input: string | null;
};

/** Up: older. Returns the oldest entry unchanged once the top is reached. */
export function recallPrevious(history: PromptHistory, currentInput: string): HistoryStep {
  if (history.entries.length === 0) {
    return { history, input: null };
  }

  if (history.index === null) {
    const index = history.entries.length - 1;
    return {
      history: { ...history, index, draft: currentInput },
      input: history.entries[index] ?? null
    };
  }

  const index = Math.max(0, history.index - 1);
  return { history: { ...history, index }, input: history.entries[index] ?? null };
}

/** Down: newer, and past the newest entry back to the draft you set aside. */
export function recallNext(history: PromptHistory): HistoryStep {
  if (history.index === null) {
    return { history, input: null };
  }

  const index = history.index + 1;
  if (index >= history.entries.length) {
    return { history: { ...history, index: null, draft: "" }, input: history.draft };
  }

  return { history: { ...history, index }, input: history.entries[index] ?? null };
}

/**
 * Up moves the caret inside a multi-line prompt and only recalls history from
 * the first line, which is what a shell does and what muscle memory expects.
 */
export function shouldRecallHistory(input: string, cursor: number): boolean {
  return !input.slice(0, cursor).includes("\n");
}

/** Down recalls only from the last line, mirroring the rule above. */
export function shouldRecallForward(input: string, cursor: number): boolean {
  return !input.slice(cursor).includes("\n");
}
