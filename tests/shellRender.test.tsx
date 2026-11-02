import type { ChildAgentSnapshot } from "../src/core/agentSupervisor.js";
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
    agents: [],
    agentTree: [],
    viewedAgent: null,
    mainAgent: { activity: "Idle", active: false, durationMs: 0, promptTokens: 0, outputTokens: 0 },
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

function child(overrides: Partial<ChildAgentSnapshot> = {}): ChildAgentSnapshot {
  return {
    id: "agent-1",
    agentType: "explore",
    description: "look around",
    state: "running",
    startedAt: 0,
    durationMs: 0,
    promptTokens: 0,
    outputTokens: 0,
    toolCalls: 0,
    streaming: null,
    entries: [],
    transcript: null,
    ...overrides
  };
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

  it("keeps the header on top and the composer on the bottom edge of a short session", () => {
    const rows = frame({ rows: 30 }).split("\n");
    expect(rows[0]).toContain("PatchPilot v2.0.0");
    expect(rows.length).toBe(29);
    expect(rows.at(-1)).toContain("tab to switch");
  });

  it("shows every entry of a long transcript", () => {
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
    expect(toolCall).toContain("Writing a file");
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
    expect(output).toContain("Allow Write?");
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

  it("shows running subagents as a tree with the call each is on", () => {
    const agents = [
      child({ id: "agent-1", description: "find compile bug", toolCalls: 3, activity: { name: "read_file", arguments: { path: "src/Main.java" } } }),
      child({ id: "agent-2", description: "check speed" })
    ];
    const output = frame({ agents, agentTree: agents });
    expect(output).toContain("2 agents running");
    expect(output).toContain("Explore 1 (find compile bug)");
    expect(output).toContain("Read(src/Main.java) · 3 tool calls");
    expect(output).toContain("Starting…");
  });

  it("lists main and every child with time and tokens under the status bar", () => {
    const output = frame({
      columns: 120,
      agents: [child({ id: "agent-1", description: "find compile bug", durationMs: 72_000, promptTokens: 9_600, outputTokens: 1_000 })],
      mainAgent: { activity: "Reading prompt", active: true, durationMs: 5_000, promptTokens: 100, outputTokens: 20 }
    });
    expect(output).toContain("↑/↓ to select");
    expect(output).toContain("ctrl+x ctrl+k stops all agents");
    expect(output).toMatch(/❯ ● main/);
    expect(output).toMatch(/○ Explore 1\s+find compile bug/);
    expect(output).toContain("1m 12s · ↑ 9.6k · ↓ 1.0k tokens");
  });

  it("shows no list without children", () => {
    expect(frame({ agents: [] })).not.toContain("↑/↓ to select");
  });

  it("follows the viewed child: its stream, its name in the composer, esc stops it", () => {
    const viewed = child({ id: "agent-2", agentType: "general", description: "fix parser", streaming: { phase: "generating", content: "child text so far", tokens: 12, tokensPerSecond: 40, writing: null } });
    const output = frame({ agents: [viewed], viewedAgent: viewed, streamingText: "main text", todos: [{ title: "main todo", status: "in_progress" }] });
    expect(output).toContain("child text so far");
    expect(output).not.toContain("main text");
    expect(output).not.toContain("main todo");
    expect(output).toContain("essage Agent 2…");
    expect(output).toContain("esc stops this agent");
    expect(output).toMatch(/❯ ● Agent 2/);
  });

  it("marks a child that ran out of steps instead of calling it done", () => {
    const output = frame({ agents: [child({ state: "incomplete", toolCalls: 25 })] });
    expect(output).toContain("Step limit reached · 25 tool calls");
    expect(output).not.toContain("Done");
  });

  it("keeps the composer open while the main agent runs", () => {
    const output = frame({ isRunning: true });
    expect(output).toContain("essage the agent");
    expect(output).not.toContain("Working");
  });

  it("names the agent asking for approval", () => {
    const output = frame({
      pendingApproval: { tool: "write_file", permission: "write", risk: "medium", reason: "", preview: "src/a.ts", arguments: { path: "src/a.ts" }, agent: "agent-2" } as never
    });
    expect(output).toContain("agent-2: Allow");
  });

  it("renders a finished subagent with the start of its answer", () => {
    const lines: LogLine[] = [
      { id: 1, kind: "tool", tone: "success", label: "Explore", text: "Done · 4 tool calls · 12s", target: "find compile bug", category: "state", agent: true, detail: "Main.java misses a semicolon on line 12." }
    ];
    const output = frame({ lines });
    expect(output).toContain("Explore(find compile bug)");
    expect(output).toContain("Done · 4 tool calls · 12s");
    expect(output).toContain("misses a semicolon");
  });

  it("renders a transcript with markdown and a diff", () => {
    const lines: LogLine[] = [
      { id: 1, kind: "user", tone: "muted", label: "you", text: "add a farewell function" },
      { id: 2, kind: "tool", tone: "success", label: "edit_file", text: "replaced 1 match in hello.py", tool: "edit_file" },
      { id: 3, kind: "final", tone: "success", label: "done", text: "Added `farewell()` to **hello.py**." }
    ];

    const output = frame({ lines });
    expect(output).toContain("add a farewell function");
    expect(output).toContain("Update");
    expect(output).not.toContain("edit_file");
    expect(output).toContain("farewell()");
  });
});
