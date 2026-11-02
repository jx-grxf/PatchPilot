import { describe, expect, it } from "vitest";
import type { ChildAgentSnapshot } from "../src/core/agentSupervisor.js";
import { agentDisplayName, agentTranscriptLines, formatAgentDuration, formatAgentFigures, moveSelection, orderAgents, windowAgents } from "../src/tui/agentView.js";

function child(id: string, overrides: Partial<ChildAgentSnapshot> = {}): ChildAgentSnapshot {
  return {
    id,
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

describe("agent view helpers", () => {
  it("names a child by type and number", () => {
    expect(agentDisplayName(child("agent-12"))).toBe("Explore 12");
    expect(agentDisplayName(child("agent-3", { agentType: "general" }))).toBe("Agent 3");
  });

  it("orders active children first, numerically within each group", () => {
    const ordered = orderAgents([child("agent-10"), child("agent-1", { state: "ok" }), child("agent-2"), child("agent-3", { state: "queued" })]);
    expect(ordered.map((agent) => agent.id)).toEqual(["agent-2", "agent-3", "agent-10", "agent-1"]);
  });

  it("moves the selection through main and the children and stops at both ends", () => {
    const agents = [child("agent-1"), child("agent-2")];
    expect(moveSelection(agents, null, 1)).toBe("agent-1");
    expect(moveSelection(agents, "agent-1", -1)).toBeNull();
    expect(moveSelection(agents, null, -1)).toBeNull();
    expect(moveSelection(agents, "agent-2", 1)).toBe("agent-2");
  });

  it("falls back to main when the selected child is gone", () => {
    expect(moveSelection([child("agent-1")], "agent-9", -1)).toBeNull();
  });

  it("keeps the selected row inside the window", () => {
    const agents = Array.from({ length: 12 }, (_, index) => child(`agent-${index + 1}`));
    const first = windowAgents(agents, null);
    expect(first.visible).toHaveLength(5);
    expect(first).toMatchObject({ hiddenAbove: 0, hiddenBelow: 7 });

    const middle = windowAgents(agents, "agent-7");
    expect(middle.visible.map((agent) => agent.id)).toContain("agent-7");
    expect(middle.hiddenAbove + middle.visible.length + middle.hiddenBelow).toBe(12);

    const last = windowAgents(agents, "agent-12");
    expect(last.visible.map((agent) => agent.id)).toContain("agent-12");
    expect(last.hiddenBelow).toBe(0);
  });

  it("formats time and tokens, dropping prompt tokens on a narrow window", () => {
    expect(formatAgentDuration(48_000)).toBe("48s");
    expect(formatAgentDuration(218_000)).toBe("3m 38s");
    const figures = { durationMs: 218_000, promptTokens: 9_600, outputTokens: 1_500 };
    expect(formatAgentFigures(figures, 120)).toBe("3m 38s · ↑ 9.6k · ↓ 1.5k tokens");
    expect(formatAgentFigures(figures, 80)).toBe("3m 38s · ↓ 1.5k tokens");
  });

  it("maps a history to stable lines and leaves live-only events out", () => {
    const agent = child("agent-2", {
      description: "fix parser",
      entries: [
        { type: "user", text: "fix the parser" },
        { type: "event", event: { type: "stream", phase: "generating", elapsedMs: 1, tokens: 1, content: "x", tokensPerSecond: 1, workState: "planning" } },
        { type: "event", event: { type: "context", usedTokens: 1, limitTokens: 2, ratio: 0.5, pressure: "low", workState: "planning" } as never },
        { type: "event", event: { type: "status", message: "probe", workState: "planning" } },
        { type: "event", event: { type: "assistant", message: "reading \u001b[31mit", workState: "planning" } },
        { type: "event", event: { type: "final", message: "done", workState: "done" } }
      ]
    });
    const lines = agentTranscriptLines(agent);
    expect(lines.map((line) => line.kind)).toEqual(["status", "user", "assistant", "final"]);
    expect(lines.map((line) => line.id)).toEqual([0, 1, 2, 3]);
    expect(lines[0]?.text).toBe("Explore 2 · fix parser");
    expect(lines[2]?.text).not.toContain("\u001b");
  });
});
