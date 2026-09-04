import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  clampSummary,
  formatEnvelope,
  maxEnvelopeChars,
  runSubagent,
  subagentToolAccess,
  subagentWorkspaceTools,
  type SubagentEnvelope
} from "../src/core/subagentRunner.js";
import type { AgentEvent, ModelChatResult, ModelClient } from "../src/core/types.js";

const stubClient: ModelClient = {
  async chat(): Promise<ModelChatResult> {
    throw new Error("the child loop is stubbed; the client should not be called");
  },
  async listModels(): Promise<string[]> {
    return [];
  }
};

async function scratchDir(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "patchpilot-subagent-"));
}

function events(...list: AgentEvent[]): (options: unknown) => AsyncGenerator<AgentEvent, void> {
  return async function* () {
    for (const event of list) {
      yield event;
    }
  };
}

const toolEvent: AgentEvent = {
  type: "tool",
  name: "read_file",
  summary: "read src/a.ts",
  content: "export const a = 1;",
  ok: true,
  workState: "reading"
};

const metricsEvent: AgentEvent = {
  type: "metrics",
  workState: "planning",
  metrics: {
    promptTokens: 10,
    cachedPromptTokens: 0,
    cacheWriteTokens: 0,
    responseTokens: 5,
    totalTokens: 15,
    evalTokensPerSecond: null,
    timeToFirstTokenMs: null,
    promptDurationMs: 0,
    responseDurationMs: 0,
    totalDurationMs: 0,
    estimatedCostUsd: 0,
    tokenSource: "provider",
    costSource: "local"
  }
};

describe("subagent envelope", () => {
  it("returns the child's answer with its step and tool counts", async () => {
    const envelope = await runSubagent(
      { type: "explore", description: "find auth", prompt: "locate auth" },
      {
        client: stubClient,
        transcriptDir: await scratchDir(),
        run: events(metricsEvent, toolEvent, { type: "final", message: "Auth lives in src/auth.ts.", workState: "done" })
      }
    );

    expect(envelope).toMatchObject({ status: "ok", steps: 1, toolCalls: 1, summary: "Auth lives in src/auth.ts." });
  });

  it("bounds the summary in the harness rather than asking the model to be brief", async () => {
    const envelope = await runSubagent(
      { type: "explore", description: "verbose", prompt: "explore" },
      {
        client: stubClient,
        transcriptDir: await scratchDir(),
        run: events({ type: "final", message: "word ".repeat(2000), workState: "done" })
      }
    );

    expect(envelope.summary.length).toBeLessThanOrEqual(maxEnvelopeChars);
    expect(envelope.summary.endsWith("…")).toBe(true);
  });

  it("reports a failed child as a result, never as a thrown error", async () => {
    const envelope = await runSubagent(
      { type: "general", description: "broken", prompt: "do a thing" },
      {
        client: stubClient,
        transcriptDir: await scratchDir(),
        run: events({ type: "error", message: "model unreachable", workState: "error" })
      }
    );

    expect(envelope.status).toBe("failed");
    expect(envelope.summary).toBe("model unreachable");
  });

  it("survives a child loop that throws mid-run", async () => {
    const envelope = await runSubagent(
      { type: "explore", description: "throws", prompt: "x" },
      {
        client: stubClient,
        transcriptDir: await scratchDir(),
        // eslint-disable-next-line require-yield
        run: async function* () {
          throw new Error("child exploded");
        }
      }
    );

    expect(envelope.status).toBe("failed");
    expect(envelope.summary).toBe("child exploded");
  });

  it("says so plainly when the child produced nothing", async () => {
    const envelope = await runSubagent(
      { type: "explore", description: "silent", prompt: "x" },
      { client: stubClient, transcriptDir: await scratchDir(), run: events() }
    );

    expect(envelope.summary).toContain("no answer");
  });
});

describe("transcript on disk", () => {
  it("writes the full trace and returns its path", async () => {
    const directory = await scratchDir();
    const envelope = await runSubagent(
      { type: "explore", description: "find auth", prompt: "locate auth" },
      {
        client: stubClient,
        transcriptDir: directory,
        run: events(toolEvent, { type: "final", message: "done", workState: "done" })
      }
    );

    expect(envelope.transcript).toBeTruthy();
    const written = await readFile(envelope.transcript ?? "", "utf8");
    // Detail the envelope omits must still be recoverable.
    expect(written).toContain("export const a = 1;");
    expect(written).toContain("locate auth");
  });

  it("still returns an envelope when the transcript cannot be written", async () => {
    const envelope = await runSubagent(
      { type: "explore", description: "x", prompt: "y" },
      {
        client: stubClient,
        transcriptDir: "/dev/null/not-a-directory",
        run: events({ type: "final", message: "fine", workState: "done" })
      }
    );

    expect(envelope.status).toBe("ok");
    expect(envelope.transcript).toBeNull();
  });
});

describe("envelope formatting", () => {
  const envelope: SubagentEnvelope = {
    status: "ok",
    description: "find auth",
    summary: "Auth lives in src/auth.ts.",
    steps: 3,
    durationMs: 4200,
    toolCalls: 5,
    transcript: "/tmp/x.md"
  };

  it("stays compact and points at the transcript", () => {
    const text = formatEnvelope(envelope);
    expect(text).toContain("[ok] find auth");
    expect(text).toContain("Auth lives in src/auth.ts.");
    expect(text).toContain("3 steps, 5 tool calls, 4s");
    expect(text).toContain("/tmp/x.md");
    expect(text.length).toBeLessThan(maxEnvelopeChars + 200);
  });

  it("omits the transcript line when there is none", () => {
    expect(formatEnvelope({ ...envelope, transcript: null })).not.toContain("transcript");
  });

  it("uses singular units where they apply", () => {
    expect(formatEnvelope({ ...envelope, steps: 1, toolCalls: 1 })).toContain("1 step, 1 tool call");
  });
});

describe("summary clamping", () => {
  it("leaves a short summary untouched", () => {
    expect(clampSummary("  Short answer.  ")).toBe("Short answer.");
  });

  it("prefers a sentence boundary near the limit", () => {
    const summary = `${"a".repeat(maxEnvelopeChars - 100)}. ${"b".repeat(400)}`;
    const clamped = clampSummary(summary);
    expect(clamped.length).toBeLessThanOrEqual(maxEnvelopeChars);
    expect(clamped).not.toContain("b");
  });

  it("clips mid-word when no sentence boundary is close enough", () => {
    const clamped = clampSummary("x".repeat(maxEnvelopeChars * 2));
    expect(clamped.length).toBeLessThanOrEqual(maxEnvelopeChars);
    expect(clamped.endsWith("…")).toBe(true);
  });

  it("collapses whitespace so the envelope stays one readable block", () => {
    expect(clampSummary("a\n\n  b\tc")).toBe("a b c");
  });
});

describe("tool access", () => {
  it("gives explore no way to change anything", () => {
    expect(subagentToolAccess.explore.readOnly).toBe(true);
    const tools = subagentWorkspaceTools(true);
    expect(tools).not.toContain("write_file");
    expect(tools).not.toContain("edit_file");
    expect(tools).toContain("read_file");
  });

  it("lets a general child edit but never run shell", () => {
    const tools = subagentWorkspaceTools(false);
    expect(tools).toContain("edit_file");
    expect(tools).not.toContain("run_shell");
  });
});
