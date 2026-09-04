import { describe, expect, it } from "vitest";
import {
  hasArgument,
  needsArgument,
  resolveSlashSubmission,
  suggestionHint,
  type PaletteSuggestion
} from "../src/tui/slashCommands.js";

function suggestion(command: string, execute: boolean): PaletteSuggestion {
  return { key: command, category: "core", label: command, detail: "", command, execute };
}

const noSelection: PaletteSuggestion[] = [];

describe("what Enter does", () => {
  it("runs a command that needs no argument", () => {
    expect(resolveSlashSubmission("/diff", [suggestion("/diff", true)], 0)).toEqual({
      action: "run",
      command: "/diff"
    });
  });

  it("completes a command that still needs an argument, with a trailing space", () => {
    expect(resolveSlashSubmission("/mod", [suggestion("/model", false)], 0)).toEqual({
      action: "complete",
      input: "/model "
    });
  });

  it("runs it once the argument is there, instead of truncating back to the command", () => {
    expect(resolveSlashSubmission("/model qwen3:8b", [suggestion("/model", false)], 0)).toEqual({
      action: "run",
      command: "/model qwen3:8b"
    });
  });

  it("runs a suggestion that supplies the whole invocation", () => {
    const picked = suggestion("/model prism-ml/bonsai-27b", true);
    expect(resolveSlashSubmission("/model bon", [picked], 0)).toEqual({
      action: "run",
      command: "/model prism-ml/bonsai-27b"
    });
  });

  it("runs exactly what was typed when nothing is highlighted", () => {
    expect(resolveSlashSubmission("/doctor", noSelection, 0)).toEqual({
      action: "run",
      command: "/doctor"
    });
  });

  it("never second-guesses a command the user spelled out in full", () => {
    expect(resolveSlashSubmission("/model qwen3:8b", noSelection, 0)).toEqual({
      action: "run",
      command: "/model qwen3:8b"
    });
  });

  it("trims surrounding whitespace before deciding", () => {
    expect(resolveSlashSubmission("  /diff  ", noSelection, 0)).toEqual({
      action: "run",
      command: "/diff"
    });
  });

  it("falls back to the typed text when the selected index is out of range", () => {
    expect(resolveSlashSubmission("/diff", [suggestion("/model", false)], 5)).toEqual({
      action: "run",
      command: "/diff"
    });
  });

  it("only ever completes, never runs, when an argument is still missing", () => {
    // The whole point: a command that needs input must not fire without it.
    for (const input of ["/model", "/model ", "/mod"]) {
      expect(resolveSlashSubmission(input, [suggestion("/model", false)], 0).action).toBe("complete");
    }
  });
});

describe("classifying usage strings", () => {
  it("treats required and optional placeholders as needing an argument", () => {
    expect(needsArgument("/model <name>")).toBe(true);
    expect(needsArgument("/compact [now|auto]")).toBe(true);
    expect(needsArgument("/diff")).toBe(false);
  });

  it("detects an argument only once there is something after the command", () => {
    expect(hasArgument("/model qwen")).toBe(true);
    expect(hasArgument("/model ")).toBe(false);
    expect(hasArgument("/model")).toBe(false);
  });
});

describe("the hint matches the behaviour", () => {
  it("says run for what runs and fill for what fills", () => {
    expect(suggestionHint(suggestion("/diff", true))).toBe("run");
    expect(suggestionHint(suggestion("/model", false))).toBe("fill");
  });
});
