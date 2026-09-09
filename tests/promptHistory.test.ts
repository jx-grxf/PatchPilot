import { describe, expect, it } from "vitest";
import {
  emptyPromptHistory,
  maxPromptHistory,
  recallNext,
  recallPrevious,
  rememberPrompt,
  shouldRecallForward,
  shouldRecallHistory
} from "../src/tui/promptHistory.js";

function withEntries(...prompts: string[]) {
  return prompts.reduce((history, prompt) => rememberPrompt(history, prompt), emptyPromptHistory());
}

describe("recording prompts", () => {
  it("keeps them in submission order", () => {
    expect(withEntries("first", "second").entries).toEqual(["first", "second"]);
  });

  it("ignores blank submissions", () => {
    expect(withEntries("real", "   ", "").entries).toEqual(["real"]);
  });

  it("does not store a prompt twice in a row", () => {
    expect(withEntries("same", "same", "same").entries).toEqual(["same"]);
  });

  it("stores a repeat that is not consecutive", () => {
    expect(withEntries("a", "b", "a").entries).toEqual(["a", "b", "a"]);
  });

  it("caps the history so a long session cannot grow without bound", () => {
    let history = emptyPromptHistory();
    for (let index = 0; index < maxPromptHistory + 50; index += 1) {
      history = rememberPrompt(history, `prompt ${index}`);
    }

    expect(history.entries).toHaveLength(maxPromptHistory);
    expect(history.entries.at(-1)).toBe(`prompt ${maxPromptHistory + 49}`);
  });
});

describe("recalling prompts", () => {
  it("walks backwards from the newest", () => {
    let history = withEntries("oldest", "middle", "newest");

    let step = recallPrevious(history, "");
    expect(step.input).toBe("newest");

    step = recallPrevious(step.history, "");
    expect(step.input).toBe("middle");

    step = recallPrevious(step.history, "");
    expect(step.input).toBe("oldest");
  });

  it("stops at the oldest instead of wrapping around", () => {
    let step = recallPrevious(withEntries("only"), "");
    step = recallPrevious(step.history, "");
    expect(step.input).toBe("only");
  });

  it("sets the unsent draft aside and gives it back", () => {
    const history = withEntries("earlier");

    const back = recallPrevious(history, "half-typed thought");
    expect(back.input).toBe("earlier");

    const forward = recallNext(back.history);
    expect(forward.input).toBe("half-typed thought");
    expect(forward.history.index).toBeNull();
  });

  it("does nothing when there is no history yet", () => {
    expect(recallPrevious(emptyPromptHistory(), "draft").input).toBeNull();
  });

  it("does nothing going forward when not browsing", () => {
    expect(recallNext(withEntries("a")).input).toBeNull();
  });

  it("walks forward through entries before reaching the draft", () => {
    let step = recallPrevious(withEntries("one", "two"), "draft");
    step = recallPrevious(step.history, "draft");
    expect(step.input).toBe("one");

    step = recallNext(step.history);
    expect(step.input).toBe("two");

    step = recallNext(step.history);
    expect(step.input).toBe("draft");
  });
});

describe("multi-line editing still owns the arrow keys", () => {
  it("recalls only when the caret is on the first line", () => {
    expect(shouldRecallHistory("single line", 5)).toBe(true);
    expect(shouldRecallHistory("first\nsecond", 3)).toBe(true);
    expect(shouldRecallHistory("first\nsecond", 9)).toBe(false);
  });

  it("goes forward only when the caret is on the last line", () => {
    expect(shouldRecallForward("single line", 5)).toBe(true);
    expect(shouldRecallForward("first\nsecond", 9)).toBe(true);
    expect(shouldRecallForward("first\nsecond", 3)).toBe(false);
  });
});
