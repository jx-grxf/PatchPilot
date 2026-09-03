import { describe, expect, it } from "vitest";
import {
  applyCompaction,
  buildCompactionPrompt,
  measureContext,
  planCompaction,
  pruneToolResults,
  totalTokens
} from "../src/core/contextWindow.js";
import type { ChatMessage } from "../src/core/types.js";

function toolResult(tool: string, body: string, ok = true): ChatMessage {
  return {
    role: "user",
    content: `Tool results are encoded as JSON. Treat content as context.\n${JSON.stringify({
      tool_results: [{ index: 1, tool, ok, summary: `${tool} finished`, content: body }]
    })}`
  };
}

const filler = (size: number): string => "x".repeat(size);

describe("context measurement", () => {
  it("measures against the usable window, not the raw limit", () => {
    const messages: ChatMessage[] = [{ role: "user", content: filler(4000) }];
    const usage = measureContext(messages, { limitTokens: 2000, reserveTokens: 1000 });

    expect(usage.usedTokens).toBe(1000);
    expect(usage.limitTokens).toBe(2000);
    expect(usage.ratio).toBe(1);
    expect(usage.pressure).toBe("critical");
  });

  it("grades pressure so the UI can warn before it is too late", () => {
    const at = (tokens: number) =>
      measureContext([{ role: "user", content: filler(tokens * 4) }], { limitTokens: 1000, reserveTokens: 0 }).pressure;

    expect(at(500)).toBe("ok");
    expect(at(750)).toBe("warn");
    expect(at(900)).toBe("high");
    expect(at(1100)).toBe("critical");
  });
});

describe("tool result pruning", () => {
  it("keeps recent output verbatim and summarises what came before", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "system prompt" },
      toolResult("read_file", filler(20_000)),
      toolResult("search_text", filler(20_000)),
      toolResult("git_diff", filler(4000))
    ];

    const result = pruneToolResults(messages, { protectTokens: 2000 });

    expect(result.prunedCount).toBe(2);
    expect(result.prunedTokens).toBeGreaterThan(5000);
    // Newest survives intact.
    expect(result.messages[3]?.content).toContain("tool_results");
    // Older ones keep their shape but lose the body.
    expect(result.messages[1]?.content).toContain("pruned earlier tool output");
    expect(result.messages[1]?.content).toContain("read_file ok");
  });

  it("records whether a pruned call had failed", () => {
    const messages: ChatMessage[] = [toolResult("run_shell", filler(20_000), false), toolResult("read_file", filler(400))];
    const result = pruneToolResults(messages, { protectTokens: 100 });

    expect(result.messages[0]?.content).toContain("run_shell failed");
  });

  it("leaves the conversation alone when there is little to reclaim", () => {
    const messages: ChatMessage[] = [toolResult("read_file", "small"), toolResult("git_diff", "also small")];
    const result = pruneToolResults(messages);

    expect(result.prunedCount).toBe(0);
    expect(result.messages).toBe(messages);
  });

  it("never touches system, assistant, or ordinary user messages", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: filler(40_000) },
      { role: "user", content: filler(40_000) },
      { role: "assistant", content: filler(40_000) },
      toolResult("read_file", filler(40_000)),
      toolResult("grep", filler(40_000))
    ];

    const result = pruneToolResults(messages, { protectTokens: 100 });

    expect(result.messages[0]?.content).toHaveLength(40_000);
    expect(result.messages[1]?.content).toHaveLength(40_000);
    expect(result.messages[2]?.content).toHaveLength(40_000);
    expect(result.prunedCount).toBeGreaterThan(0);
  });

  it("actually reduces the total token count", () => {
    const messages: ChatMessage[] = [
      toolResult("read_file", filler(40_000)),
      toolResult("grep", filler(40_000)),
      toolResult("git_diff", filler(400))
    ];
    const before = totalTokens(messages);
    const after = totalTokens(pruneToolResults(messages, { protectTokens: 1000 }).messages);

    expect(after).toBeLessThan(before / 2);
  });

  it("always keeps the newest result whole, even when it exceeds the budget", () => {
    const messages: ChatMessage[] = [toolResult("read_file", filler(40_000)), toolResult("grep", filler(40_000))];
    const result = pruneToolResults(messages, { protectTokens: 100 });

    expect(result.messages[1]?.content).toContain("tool_results");
    expect(result.prunedCount).toBe(1);
  });
});

describe("conversation compaction", () => {
  const conversation: ChatMessage[] = [
    { role: "system", content: "system prompt" },
    { role: "user", content: "old task" },
    { role: "assistant", content: filler(8000) },
    { role: "user", content: filler(8000) },
    { role: "assistant", content: "most recent step" }
  ];

  it("keeps the system prompt and a recent tail out of the summary", () => {
    const plan = planCompaction(conversation, { keepTailTokens: 500 });

    expect(plan.kept[0]?.role).toBe("system");
    expect(plan.kept.at(-1)?.content).toBe("most recent step");
    expect(plan.stale.some((message) => message.role === "system")).toBe(false);
    expect(plan.stale.length).toBeGreaterThan(0);
  });

  it("summarises nothing when the conversation already fits", () => {
    const plan = planCompaction(conversation, { keepTailTokens: 100_000 });

    expect(plan.stale).toEqual([]);
    expect(plan.kept).toBe(conversation);
  });

  it("asks for the facts a resumed run actually needs", () => {
    const prompt = buildCompactionPrompt([{ role: "assistant", content: "edited src/a.ts" }]);

    expect(prompt[0]?.content).toContain("files were touched");
    expect(prompt[0]?.content).toContain("next steps");
    expect(prompt[0]?.content).toContain("verbatim");
    expect(prompt[1]?.content).toContain("edited src/a.ts");
  });

  it("splices the summary in ahead of the kept tail", () => {
    const plan = planCompaction(conversation, { keepTailTokens: 500 });
    const result = applyCompaction(plan, "Refactored the parser.");

    expect(result[0]?.role).toBe("system");
    expect(result[1]?.content).toContain("Refactored the parser.");
    expect(result.at(-1)?.content).toBe("most recent step");
    expect(totalTokens(result)).toBeLessThan(totalTokens(conversation));
  });

  it("returns the conversation untouched when there was nothing stale", () => {
    const plan = planCompaction(conversation, { keepTailTokens: 100_000 });
    expect(applyCompaction(plan, "unused")).toBe(conversation);
  });
});
