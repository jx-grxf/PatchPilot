import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { Shell, type ShellProps } from "../src/tui/shell/Shell.js";
import { emptySessionTelemetry } from "../src/core/tokenAccounting.js";
import type { LogLine } from "../src/tui/types.js";

/**
 * Renders the whole shell, not just one component, so a broken layout or a
 * missing prop shows up here rather than the first time someone launches it.
 */
function props(overrides: Partial<ShellProps> = {}): ShellProps {
  return {
    provider: "local-openai",
    model: "google/gemma-4-12b-qat",
    workspace: "/Users/dev/project",
    version: "2.0.0",
    agentMode: "build",
    allowWrite: false,
    allowShell: false,
    workState: "idle",
    status: "idle",
    isRunning: false,
    streamProgress: null,
    streamingText: "",
    contextUsage: null,
    transcriptEpoch: 0,
    ultramaxxRun: false,
    sessionTelemetry: emptySessionTelemetry(),
    lines: [],
    todos: [],
    todoFrame: 0,
    pendingApproval: null,
    bypassConfirmation: false,
    updatePrompt: null,
    updateBusy: false,
    input: "",
    paletteItems: [],
    paletteIndex: 0,
    rows: 40,
    columns: 100,
    activeHost: null,
    onChange: () => undefined,
    onSubmit: () => undefined,
    onAttach: () => "",
    onHistoryPrevious: () => null,
    onHistoryNext: () => null,
    ...overrides
  };
}

function frame(overrides: Partial<ShellProps> = {}): string {
  const { lastFrame } = render(<Shell {...props(overrides)} />);
  return (lastFrame() ?? "")
    .split("\n")
    .map((row) => row.trimEnd())
    .join("\n");
}

describe("shell renders at rest", () => {
  it("shows the model, workspace and mode without a transcript", () => {
    const output = frame();
    expect(output).toContain("PatchPilot");
    expect(output).toContain("gemma-4-12b-qat");
    expect(output).toContain("build");
  });

  it("prints the launch header without a mascot or wordmark", () => {
    const output = frame();
    expect(output).toContain("PatchPilot v2.0.0");
    expect(output).not.toContain("██");
  });

  it("pins the composer to the bottom while the transcript is short", async () => {
    const { lastFrame } = render(<Shell {...props({ rows: 30 })} />);
    // Exact heights are measured just after the frame commits.
    await vi.waitFor(() => expect((lastFrame() ?? "").split("\n").length).toBe(29));
    const rows = (lastFrame() ?? "").split("\n");
    expect(rows[0]).toContain("PatchPilot v2.0.0");
    expect(rows.at(-1)).toContain("tab to cycle");
  });

  it("stops padding once the transcript fills the window", () => {
    const lines: LogLine[] = Array.from({ length: 60 }, (_, index) => ({ id: index + 1, kind: "status", tone: "muted", label: "status", text: `entry ${index}` }));
    const output = frame({ rows: 30, lines });
    expect(output).toContain("entry 59");
  });

  it("survives a narrow terminal", () => {
    expect(() => frame({ columns: 40, rows: 20 })).not.toThrow();
  });
});

describe("shell renders live state", () => {
  it("shows prompt evaluation distinctly from generation", () => {
    const reading = frame({
      isRunning: true,
      streamProgress: { phase: "prompt", elapsedMs: 3400, tokens: 0, tokensPerSecond: null }
    });
    expect(reading).toContain("Reading prompt");

    const writing = frame({
      isRunning: true,
      streamProgress: { phase: "generating", elapsedMs: 8100, tokens: 142, tokensPerSecond: 15.6 }
    });
    expect(writing).toContain("15.6 tok/s");

    const toolCall = frame({
      isRunning: true,
      streamProgress: {
        phase: "generating",
        elapsedMs: 12_000,
        tokens: 0,
        tokensPerSecond: null,
        writing: { tool: "write_file", chars: 12_400 }
      }
    });
    expect(toolCall).toContain("Writing write_file");
    expect(toolCall).toContain("12k chars");
  });

  it("shows the context meter with a bar and a percentage", () => {
    const output = frame({
      contextUsage: { usedTokens: 13_200, limitTokens: 32_768, ratio: 0.41, pressure: "ok" }
    });
    expect(output).toContain("ctx");
    expect(output).toContain("41%");
  });

  it("renders a pending approval prominently", () => {
    const output = frame({
      pendingApproval: {
        id: "approval-1",
        tool: "write_file",
        permission: "write",
        risk: "high",
        preview: "src/a.ts",
        arguments: { path: "src/a.ts" }
      }
    });
    expect(output).toContain("write_file");
  });

  it("renders the todo dock when there are todos", () => {
    const output = frame({
      todos: [
        { id: "read", content: "Read the parser", status: "completed" },
        { id: "flag", content: "Add the flag", status: "in_progress" }
      ]
    });
    expect(output).toContain("Add the flag");
  });

  it("renders a transcript with markdown and a diff", () => {
    const lines: LogLine[] = [
      { id: 1, kind: "user", tone: "muted", label: "you", text: "add a farewell function" },
      { id: 2, kind: "tool", tone: "success", label: "edit_file", text: "replaced 1 match in hello.py", tool: "edit_file" },
      { id: 3, kind: "final", tone: "success", label: "done", text: "Added `farewell()` to **hello.py**." }
    ];

    const output = frame({ lines });
    expect(output).toContain("add a farewell function");
    expect(output).toContain("edit_file");
    expect(output).toContain("farewell()");
  });
});
