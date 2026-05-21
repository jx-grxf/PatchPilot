import { describe, expect, it } from "vitest";
import { isSecretLikeText, planCompaction } from "../src/core/compaction.js";
import { createContextItem } from "../src/core/contextItem.js";

describe("compaction planning", () => {
  it("keeps pinned and task-referenced file paths exact", () => {
    const pinned = createContextItem({
      id: "pin-1",
      kind: "pinned_file",
      source: "user",
      label: "notes.md",
      path: "notes.md",
      tokenEstimate: 1000
    });
    const referencedAttachment = createContextItem({
      id: "attachment-1",
      kind: "attachment",
      source: "user",
      label: "briefing.pdf",
      path: "/tmp/briefing.pdf",
      tokenEstimate: 1000
    });
    const oldTool = createContextItem({
      id: "tool-1",
      kind: "tool_result",
      source: "tool",
      label: "list_files ok",
      tokenEstimate: 1000
    });

    const plan = planCompaction([oldTool, referencedAttachment, pinned], {
      targetTokens: 1000,
      currentTask: "use /tmp/briefing.pdf again",
      minItemsToCompact: 1
    });

    expect(plan.pressure).toBe("critical");
    expect(plan.keep.map((entry) => entry.item.id)).toEqual(expect.arrayContaining(["pin-1", "attachment-1"]));
    expect(plan.drop.map((entry) => entry.item.id)).toContain("tool-1");
  });

  it("excludes secret-like context from durable summaries", () => {
    const secretTurn = createContextItem({
      id: "turn-secret",
      kind: "turn",
      source: "assistant",
      label: "env",
      text: "OPENROUTER_API_KEY=sk-1234567890abcdef1234567890abcdef",
      tokenEstimate: 1000
    });
    const sensitivePath = createContextItem({
      id: "file-secret",
      kind: "attachment",
      source: "user",
      label: ".env",
      path: ".env",
      tokenEstimate: 1000
    });

    const plan = planCompaction([secretTurn, sensitivePath], {
      targetTokens: 1,
      minItemsToCompact: 1
    });

    expect(isSecretLikeText("GEMINI_API_KEY=AIza123456789012345678901234")).toBe(true);
    expect(plan.blockedSecrets.map((entry) => entry.item.id)).toEqual(["turn-secret", "file-secret"]);
    expect(plan.summarize).toHaveLength(0);
    expect(plan.drop.map((entry) => entry.item.id)).toEqual(["turn-secret", "file-secret"]);
  });

  it("orders pressure drops before summary candidates", () => {
    const oldTool = createContextItem({
      id: "tool-ok",
      kind: "tool_result",
      source: "tool",
      label: "git_status ok",
      createdAt: "2026-05-21T10:00:00.000Z",
      tokenEstimate: 1000,
      priority: 10
    });
    const assistantTurn = createContextItem({
      id: "assistant-turn",
      kind: "turn",
      source: "assistant",
      label: "answer",
      createdAt: "2026-05-21T10:01:00.000Z",
      text: "Long answer",
      tokenEstimate: 1000
    });
    const failedTool = createContextItem({
      id: "tool-failed",
      kind: "tool_result",
      source: "tool",
      label: "test failed",
      createdAt: "2026-05-21T10:02:00.000Z",
      tokenEstimate: 1000,
      priority: 45
    });

    const plan = planCompaction([failedTool, assistantTurn, oldTool], {
      targetTokens: 1000,
      minItemsToCompact: 1
    });

    expect(plan.drop.map((entry) => entry.item.id)).toEqual(["tool-ok"]);
    expect(plan.summarize.map((entry) => entry.item.id)).toEqual(["assistant-turn", "tool-failed"]);
  });
});
