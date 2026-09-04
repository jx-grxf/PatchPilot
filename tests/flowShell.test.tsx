import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { FlowShell } from "../src/tui/experimental/FlowShell.js";
import { Markdown } from "../src/tui/components/Markdown.js";
import type { LogLine, TranscriptBlockKind } from "../src/tui/types.js";

let nextId = 1;

function line(kind: TranscriptBlockKind, text: string, extra: Partial<LogLine> = {}): LogLine {
  return { id: nextId++, kind, tone: "muted", label: kind, text, ...extra };
}

/** Ink pads to the terminal width; comparisons should ignore that. */
function output(frames: string[] | undefined): string {
  return (frames?.at(-1) ?? "")
    .split("\n")
    .map((row) => row.trimEnd())
    .join("\n");
}

describe("FlowShell", () => {
  it("prints every entry, with no windowing", () => {
    const lines = Array.from({ length: 40 }, (_, index) => line("status", `entry ${index}`));
    const { lastFrame } = render(<FlowShell lines={lines} transcriptEpoch={0} columns={80} />);

    // A windowed pager would show only the last screenful; Static shows all.
    expect(output([lastFrame() ?? ""])).toContain("entry 0");
    expect(output([lastFrame() ?? ""])).toContain("entry 39");
  });

  it("renders nothing for an empty transcript rather than a frame of chrome", () => {
    const { lastFrame } = render(<FlowShell lines={[]} transcriptEpoch={0} columns={80} />);
    expect(output([lastFrame() ?? ""]).trim()).toBe("");
  });

  it("renders each entry kind without throwing", () => {
    const lines: LogLine[] = [
      line("user", "add a farewell function"),
      line("assistant", "I'll read the file first."),
      line("thinking", "The file defines greet, so farewell goes beside it."),
      line("tool", "replaced 1 match in hello.py", { tool: "edit_file", tone: "success" }),
      line("diff", "@@ -1 +1,3 @@\n+def farewell(name):"),
      line("error", "command failed", { detail: "exit code 1" }),
      line("approval", "write to hello.py"),
      line("final", "Added `farewell()` to hello.py.")
    ];

    const frame = output([render(<FlowShell lines={lines} transcriptEpoch={0} columns={80} />).lastFrame() ?? ""]);

    expect(frame).toContain("add a farewell function");
    expect(frame).toContain("read the file first");
    expect(frame).toContain("edit_file");
    expect(frame).toContain("def farewell(name)");
    expect(frame).toContain("command failed");
    expect(frame).toContain("Added");
  });

  it("collapses a pathological single-line entry instead of wrecking the layout", () => {
    const frame = output([
      render(<FlowShell lines={[line("status", "x".repeat(5000))]} transcriptEpoch={0} columns={80} />).lastFrame() ?? ""
    ]);

    expect(frame.split("\n").length).toBeLessThan(4);
    expect(frame).toContain("…");
  });

  it("keeps entries in order", () => {
    const frame = output([
      render(
        <FlowShell lines={[line("status", "first"), line("status", "second"), line("status", "third")]} transcriptEpoch={0} columns={80} />
      ).lastFrame() ?? ""
    ]);

    expect(frame.indexOf("first")).toBeLessThan(frame.indexOf("second"));
    expect(frame.indexOf("second")).toBeLessThan(frame.indexOf("third"));
  });
});

describe("Markdown rendering", () => {
  it("renders headings, lists and emphasis as text", () => {
    const frame = output([render(<Markdown text={"# Title\n\n- one\n- two\n\n**bold** and `code`"} width={80} />).lastFrame() ?? ""]);

    expect(frame).toContain("Title");
    expect(frame).toContain("• one");
    expect(frame).toContain("bold");
    expect(frame).toContain("code");
  });

  it("renders a fenced code block with its content intact", () => {
    const frame = output([render(<Markdown text={"```ts\nconst x: number = 1;\n```"} width={80} />).lastFrame() ?? ""]);
    expect(frame).toContain("const x: number = 1;");
  });

  it("keeps diff signs, so the diff reads without colour", () => {
    const frame = output([render(<Markdown text={"```diff\n+added\n-removed\n```"} width={80} />).lastFrame() ?? ""]);
    expect(frame).toContain("+added");
    expect(frame).toContain("-removed");
  });

  it("does not mangle a glob pattern into emphasis", () => {
    const frame = output([render(<Markdown text="Files under src/**/*.ts changed." width={80} />).lastFrame() ?? ""]);
    expect(frame).toContain("src/**/*.ts");
  });

  it("renders plain prose unchanged", () => {
    const frame = output([render(<Markdown text="Just a sentence." width={80} />).lastFrame() ?? ""]);
    expect(frame.trim()).toBe("Just a sentence.");
  });
});
