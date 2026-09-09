import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { ExperimentalShell, type ExperimentalShellProps } from "../src/tui/experimental/ExperimentalShell.js";
import { ThemePicker } from "../src/tui/experimental/ThemePicker.js";
import { emptySessionTelemetry } from "../src/core/tokenAccounting.js";
import type { LogLine } from "../src/tui/types.js";

/**
 * Renders the whole shell, not just one component, so a broken layout or a
 * missing prop shows up here rather than the first time someone launches it.
 */
function props(overrides: Partial<ExperimentalShellProps> = {}): ExperimentalShellProps {
  return {
    provider: "local-openai",
    model: "google/gemma-4-12b-qat",
    workspace: "/Users/dev/project",
    sessionId: "session-1",
    agentMode: "build",
    allowWrite: false,
    allowShell: false,
    subagents: false,
    workState: "idle",
    status: "idle",
    isRunning: false,
    streamProgress: null,
    contextUsage: null,
    flow: true,
    transcriptEpoch: 0,
    ultramaxxRun: false,
    telemetry: null,
    sessionTelemetry: emptySessionTelemetry(),
    draftTokens: 0,
    lines: [],
    todos: [],
    todoFrame: 0,
    pendingApproval: null,
    bypassConfirmation: false,
    updatePrompt: null,
    updateBusy: false,
    transcriptScrollOffset: 0,
    input: "",
    paletteItems: [],
    paletteIndex: 0,
    rows: 40,
    columns: 100,
    activeHost: null,
    artifacts: [],
    onChange: () => undefined,
    onSubmit: () => undefined,
    onAttach: () => "",
    onHistoryPrevious: () => null,
    onHistoryNext: () => null,
    ...overrides
  };
}

function frame(overrides: Partial<ExperimentalShellProps> = {}): string {
  const { lastFrame } = render(<ExperimentalShell {...props(overrides)} />);
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

  it("renders in both flow and windowed layouts", () => {
    expect(frame({ flow: true }).length).toBeGreaterThan(50);
    expect(frame({ flow: false }).length).toBeGreaterThan(50);
  });

  it("survives a narrow terminal", () => {
    expect(() => frame({ columns: 40, rows: 20 })).not.toThrow();
  });
});

describe("shell renders live state", () => {
  it("marks the flow interface as the default", () => {
    const { lastFrame } = render(
      <ThemePicker
        options={[
          { value: "flow", label: "Flow", description: "Terminal scrollback" },
          { value: "new", label: "New", description: "Fullscreen" }
        ]}
        selectedIndex={0}
        currentValue="flow"
        height={12}
      />
    );
    expect(lastFrame()).toContain("Flow · current · default");
    expect(lastFrame()).not.toContain("New · default");
  });

  it("shows prompt evaluation distinctly from generation", () => {
    const reading = frame({
      isRunning: true,
      streamProgress: { phase: "prompt", elapsedMs: 3400, tokens: 0, tokensPerSecond: null }
    });
    expect(reading).toContain("reading prompt");

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
    expect(toolCall).toContain("write_file · 12k chars");
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
