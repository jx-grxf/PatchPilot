import { describe, expect, it } from "vitest";
import { composerView, deleteComposerText, insertComposerText } from "../src/tui/experimental/composer.js";

describe("composerView", () => {
  it("places the cursor for a short single-line draft", () => {
    const view = composerView("hello", 5, 40, 3);
    expect(view.rows).toEqual(["hello"]);
    expect(view.cursorRow).toBe(0);
    expect(view.cursorCol).toBe(5);
    expect(view.hiddenAbove).toBe(0);
  });

  it("supports a cursor in the middle of the draft", () => {
    const view = composerView("hello world", 3, 40, 3);
    expect(view.cursorRow).toBe(0);
    expect(view.cursorCol).toBe(3);
  });

  it("maps the cursor across hard-wrapped rows", () => {
    const view = composerView("abcdefghij", 7, 4, 4);
    // width 4 → rows ["abcd","efgh","ij"], cursor 7 → row 1, col 3
    expect(view.totalRows).toBe(3);
    expect(view.cursorRow).toBe(1);
    expect(view.cursorCol).toBe(3);
  });

  it("tracks the cursor across explicit newlines", () => {
    const view = composerView("ab\ncd", 4, 40, 4);
    // rows ["ab","cd"], cursor index 4 = second char of "cd"
    expect(view.totalRows).toBe(2);
    expect(view.cursorRow).toBe(1);
    expect(view.cursorCol).toBe(1);
  });

  it("scrolls the window so the cursor row stays visible", () => {
    const input = Array.from({ length: 12 }, (_, i) => `line${i}`).join("\n");
    const atEnd = composerView(input, input.length, 40, 3);
    expect(atEnd.rows.length).toBe(3);
    expect(atEnd.hiddenAbove).toBeGreaterThan(0);
    expect(atEnd.cursorRow).toBeGreaterThanOrEqual(0);
    expect(atEnd.cursorRow).toBeLessThan(3);

    const atStart = composerView(input, 0, 40, 3);
    expect(atStart.hiddenAbove).toBe(0);
    expect(atStart.cursorRow).toBe(0);
  });

  it("handles an empty draft", () => {
    const view = composerView("", 0, 40, 3);
    expect(view.rows).toEqual([""]);
    expect(view.cursorRow).toBe(0);
    expect(view.cursorCol).toBe(0);
  });

  it("inserts text at the active cursor", () => {
    expect(insertComposerText("helo", 2, "l")).toEqual({
      input: "hello",
      cursor: 3,
    });
  });

  it("deletes backward from the cursor", () => {
    expect(deleteComposerText("hello", 3, "backward")).toEqual({
      input: "helo",
      cursor: 2,
    });
  });

  it("deletes forward at the cursor", () => {
    expect(deleteComposerText("hello", 1, "forward")).toEqual({
      input: "hllo",
      cursor: 1,
    });
  });

  it("keeps delete operations bounded at draft edges", () => {
    expect(deleteComposerText("hello", 0, "backward")).toEqual({
      input: "hello",
      cursor: 0,
    });
    expect(deleteComposerText("hello", 5, "forward")).toEqual({
      input: "hello",
      cursor: 5,
    });
  });
});
