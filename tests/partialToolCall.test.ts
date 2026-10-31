import { describe, expect, it } from "vitest";
import { readPartialArguments, readPartialToolCallText, textBeforeToolCall } from "../src/core/partialToolCall.js";

describe("readPartialArguments", () => {
  it("reads a path and a body cut off mid-string", () => {
    expect(readPartialArguments('{"path": "index.html", "content": "<h1>Hi</h1>\\n<p>wor')).toEqual({ path: "index.html", body: "<h1>Hi</h1>\n<p>wor" });
  });

  it("does not break on a dangling escape", () => {
    expect(readPartialArguments('{"path":"a","content":"x\\')).toEqual({ path: "a", body: "x" });
  });

  it("uses new_string for edits", () => {
    expect(readPartialArguments('{"path":"a.ts","old_string":"a","new_string":"b')).toMatchObject({ body: "b" });
  });
});

describe("readPartialToolCallText", () => {
  it("reads the Qwen3-Coder XML form", () => {
    const text = "Creating it.\n<tool_call>\n<function=write>\n<parameter=path>\nnotes.md\n</parameter>\n<parameter=content>\n# Notes\n- one";
    expect(readPartialToolCallText(text)).toEqual({ name: "write", path: "notes.md", body: "# Notes\n- one" });
    expect(textBeforeToolCall(text)).toBe("Creating it.\n");
  });

  it("reads the Hermes JSON form", () => {
    expect(readPartialToolCallText('<tool_call>\n{"name": "write", "arguments": {"path": "a.txt", "content": "he')).toEqual({ name: "write", path: "a.txt", body: "he" });
  });

  it("ignores ordinary text", () => {
    expect(readPartialToolCallText("just an answer")).toBeNull();
  });
});
