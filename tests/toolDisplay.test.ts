import { describe, expect, it } from "vitest";
import { describeStreamingCall, describeToolTarget, formatToolHeading } from "../src/tui/toolDisplay.js";
import { belongsInTranscript } from "../src/tui/transcriptEvents.js";

describe("tool display", () => {
  it("names a call by verb and target", () => {
    expect(formatToolHeading("write_file", "write_file", "index.html")).toBe("Write(index.html)");
    expect(formatToolHeading("run_shell", "run_shell", "npm test")).toBe("Bash(npm test)");
    expect(formatToolHeading("edit_file", "edit_file", undefined)).toBe("Update");
    expect(formatToolHeading(undefined, "explore agent", undefined)).toBe("explore agent");
  });

  it("picks the identifying argument and clips it", () => {
    expect(describeToolTarget({ path: "src/a.ts", content: "x" })).toBe("src/a.ts");
    expect(describeToolTarget({ command: "npm   run\nbuild" })).toBe("npm run build");
    expect(describeToolTarget({ command: "x".repeat(100) }, 20)).toHaveLength(20);
    expect(describeToolTarget(undefined)).toBeUndefined();
  });

  it("says what a streaming call is doing in words", () => {
    expect(describeStreamingCall("write")).toBe("Writing a file");
    expect(describeStreamingCall("run_shell")).toBe("Preparing a command");
    expect(describeStreamingCall("mystery")).toBe("Calling mystery");
  });
});

describe("belongsInTranscript", () => {
  it("keeps harness status and todo tool entries out of scrollback", () => {
    expect(belongsInTranscript({ type: "status", message: "checking", workState: "inspecting" }, false)).toBe(false);
    expect(belongsInTranscript({ type: "tool", name: "update_todo", summary: "0/2", ok: true, workState: "planning" }, false)).toBe(false);
    expect(belongsInTranscript({ type: "tool", name: "write_file", summary: "wrote a", ok: true, workState: "editing" }, false)).toBe(true);
    expect(belongsInTranscript({ type: "assistant", message: "hi", workState: "done" }, false)).toBe(true);
  });

  it("shows everything with debug on", () => {
    expect(belongsInTranscript({ type: "status", message: "checking", workState: "inspecting" }, true)).toBe(true);
  });
});
