import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { FlowShell } from "../src/tui/shell/FlowShell.js";
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

  it("reprints the whole history when the viewed agent changes", () => {
    const main = [line("status", "main entry")];
    const child = [line("status", "child entry")];
    const { lastFrame, rerender } = render(<FlowShell lines={main} transcriptEpoch={0} view={null} columns={80} />);
    expect(output([lastFrame() ?? ""])).toContain("main entry");

    rerender(<FlowShell lines={child} transcriptEpoch={0} view="agent-1" columns={80} />);
    expect(output([lastFrame() ?? ""])).toContain("child entry");

    rerender(<FlowShell lines={main} transcriptEpoch={0} view={null} columns={80} />);
    expect(output([lastFrame() ?? ""])).toContain("main entry");
  });

  it("does not print a failure twice when its detail repeats the summary", () => {
    const denied = 'run_shell denied. executable "bash" is blocked.';
    const { lastFrame } = render(<FlowShell lines={[line("tool", denied, { tone: "warning", detail: denied, label: "Bash" })]} transcriptEpoch={0} columns={100} />);
    expect(output([lastFrame() ?? ""]).split(denied)).toHaveLength(2);
  });

  it("indents every shell output row behind the result mark", () => {
    const detail = ["drwx alpha", "drwx beta", "drwx gamma", "drwx delta", "drwx epsilon"].join("\n");
    const tool = line("tool", "ls", { tone: "success", category: "shell", detail, label: "Bash", tool: "run_shell", target: "ls" });
    const rows = output([render(<FlowShell lines={[tool]} transcriptEpoch={0} columns={80} />).lastFrame() ?? ""]).split("\n");

    const head = rows.find((row) => row.includes("drwx alpha")) ?? "";
    const column = head.indexOf("drwx");
    for (const name of ["beta", "gamma", "delta"]) {
      expect(rows.find((row) => row.includes(`drwx ${name}`))?.indexOf("drwx")).toBe(column);
    }
    expect(rows.find((row) => row.includes("more line"))?.trim()).toBe("… 1 more line");
  });

  it("prints the banner into a fresh region after /clear, so the erased screen is not blank", () => {
    const banner = { version: "1.0.0", model: "banner-model", host: "local", workspace: "/tmp/w", columns: 80 };
    const { lastFrame, rerender } = render(<FlowShell lines={[line("status", "old entry")]} transcriptEpoch={0} banner={banner} columns={80} />);
    rerender(<FlowShell lines={[]} transcriptEpoch={1} banner={banner} columns={80} />);
    expect(output([lastFrame() ?? ""])).toContain("banner-model");
    expect(output([lastFrame() ?? ""])).not.toContain("old entry");
  });

  it("keeps the banner out of a child's history", () => {
    const banner = { version: "1.0.0", model: "banner-model", host: "local", workspace: "/tmp/w", columns: 80 };
    const { lastFrame } = render(<FlowShell lines={[line("status", "child entry")]} transcriptEpoch={0} view="agent-1" banner={banner} columns={80} />);
    expect(output([lastFrame() ?? ""])).not.toContain("banner-model");
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
    expect(frame).toContain("● Update");
    expect(frame).toContain("⎿  replaced 1 match in hello.py");
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
