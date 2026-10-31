import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRunner, sealDanglingToolCalls, withTurnContext } from "../src/core/agent.js";
import { setModelCapabilities } from "../src/core/capability.js";
import type { AgentEvent, ChatMessage, ModelChatOptions, ModelChatResult, ModelClient, RawToolCall } from "../src/core/types.js";
import { toOllamaMessages, toOpenAIMessages } from "../src/core/wireMessages.js";

function telemetry(): ModelChatResult["telemetry"] {
  return {
    promptTokens: 10,
    cachedPromptTokens: 0,
    cacheWriteTokens: 0,
    responseTokens: 1,
    totalTokens: 11,
    evalTokensPerSecond: null,
    timeToFirstTokenMs: null,
    promptDurationMs: 0,
    responseDurationMs: 0,
    totalDurationMs: 0,
    estimatedCostUsd: 0,
    tokenSource: "provider",
    costSource: "local"
  };
}

type Reply = { content?: string; toolCalls?: RawToolCall[]; truncated?: boolean };

/** Plays back scripted replies and records exactly what each request carried. */
function scriptedClient(replies: Reply[]): { client: ModelClient; requests: ChatMessage[][] } {
  const requests: ChatMessage[][] = [];
  const client: ModelClient = {
    async chat(options: ModelChatOptions): Promise<ModelChatResult> {
      requests.push(structuredClone(options.messages));
      const reply = replies.shift() ?? { content: "done" };
      return { content: reply.content ?? "", toolCalls: reply.toolCalls, truncated: reply.truncated, telemetry: telemetry() };
    },
    async listModels() {
      return [];
    }
  };
  return { client, requests };
}

async function drain(events: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const seen: AgentEvent[] = [];
  for await (const event of events) {
    seen.push(event);
  }
  return seen;
}

async function setup(replies: Reply[], maxSteps = 200) {
  const workspace = await mkdtemp(path.join(tmpdir(), "pp-conv-"));
  setModelCapabilities("local-openai", "scripted", { nativeToolCalls: true, detail: "test" });
  const { client, requests } = scriptedClient(replies);
  const conversation: ChatMessage[] = [];
  const makeRunner = () =>
    new AgentRunner({
      provider: "local-openai",
      model: "scripted",
      ollamaUrl: "http://127.0.0.1:1234/v1",
      workspace,
      mode: "bypass",
      allowWrite: true,
      allowShell: true,
      maxSteps,
      subagents: false,
      client,
      conversation
    });
  return { workspace, requests, conversation, makeRunner };
}

describe("persistent conversation", () => {
  it("lets a follow-up see what the previous turn did", async () => {
    const { requests, makeRunner } = await setup([
      { content: "I would call it notes.txt. Shall I create it?" },
      { toolCalls: [{ name: "write", arguments: { path: "notes.txt", content: "hello" } }] },
      { content: "Created notes.txt." }
    ]);

    await drain(makeRunner().run("suggest a file name for my notes"));
    await drain(makeRunner().run("ja erstell die datei"));

    const followUp = requests[1] ?? [];
    expect(followUp.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(followUp[2]?.content).toContain("notes.txt");
  });

  it("records calls and results in the shape the chat template expects", async () => {
    const { workspace, requests, makeRunner } = await setup([
      { toolCalls: [{ name: "write", arguments: { path: "a.txt", content: "x" } }] },
      { content: "Done." }
    ]);

    await drain(makeRunner().run("create a.txt"));

    const second = requests[1] ?? [];
    const assistant = second.find((message) => message.role === "assistant");
    const tool = second.find((message) => message.role === "tool");
    expect(assistant?.toolCalls?.[0]).toMatchObject({ name: "write", arguments: { path: "a.txt" } });
    expect(tool?.toolCallId).toBe(assistant?.toolCalls?.[0]?.id);
    expect(second.some((message) => message.content.includes('"tool_results"'))).toBe(false);
    expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("x");
  });

  it("does not stop a short request after a handful of steps", async () => {
    const reads = Array.from({ length: 9 }, (_, index) => ({
      toolCalls: [{ name: "glob", arguments: { pattern: `*${index}` } }]
    }));
    const { makeRunner } = await setup([...reads, { content: "All done." }]);

    const events = await drain(makeRunner().run("look around"));

    expect(events.at(-1)).toMatchObject({ type: "final", message: "All done.", workState: "done" });
  });

  it("keeps the system prompt byte-identical across turns", async () => {
    const { requests, makeRunner } = await setup([{ content: "one" }, { content: "two" }]);

    await drain(makeRunner().run("first"));
    await drain(makeRunner().run("second"));

    expect(requests[1]?.[0]?.content).toBe(requests[0]?.[0]?.content);
  });

  it("answers a bad call in its own slot and still runs the rest of the batch", async () => {
    const { workspace, requests, makeRunner } = await setup([
      {
        toolCalls: [
          { name: "teleport", arguments: {} },
          { name: "write", arguments: { path: "b.txt", content: "ok" } }
        ]
      },
      { content: "Done." }
    ]);

    await drain(makeRunner().run("make b.txt"));

    const results = (requests[1] ?? []).filter((message) => message.role === "tool");
    expect(results).toHaveLength(2);
    expect(results[0]?.content).toContain("Unknown tool");
    expect(await readFile(path.join(workspace, "b.txt"), "utf8")).toBe("ok");
  });
});

describe("output limit", () => {
  it("asks for smaller steps instead of ending the run when a reply is cut off", async () => {
    const { requests, makeRunner } = await setup([{ content: "<html>half a page", truncated: true }, { content: "Done in parts." }]);

    const events = await drain(makeRunner().run("write a big page"));

    expect(events.at(-1)).toMatchObject({ type: "final", message: "Done in parts.", workState: "done" });
    expect(requests[1]?.at(-1)?.content).toContain("cut off");
  });
});

describe("conversation hygiene", () => {
  it("fills in results for calls a stopped run never answered", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read", arguments: {} }, { id: "c2", name: "read", arguments: {} }] },
      { role: "tool", toolCallId: "c1", toolName: "read", content: "ok" }
    ];

    sealDanglingToolCalls(messages);

    expect(messages.map((message) => message.toolCallId ?? message.role)).toEqual(["user", "assistant", "c1", "c2"]);
  });

  it("attaches turn context to the request instead of the system prompt", () => {
    expect(withTurnContext("fix it", "")).toBe("fix it");
    expect(withTurnContext("fix it", "ULTRAFAST")).toContain("<context>\nULTRAFAST\n</context>");
  });
});

describe("wire format", () => {
  const history: ChatMessage[] = [
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read", arguments: { path: "a" } }] },
    { role: "tool", toolCallId: "c1", toolName: "read", content: "file body" }
  ];

  it("sends OpenAI-style tool_calls with string arguments and matching ids", () => {
    expect(toOpenAIMessages(history)).toEqual([
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } }] },
      { role: "tool", tool_call_id: "c1", content: "file body" }
    ]);
  });

  it("sends Ollama-style tool_calls with object arguments", () => {
    expect(toOllamaMessages(history)).toEqual([
      { role: "assistant", content: "", tool_calls: [{ function: { name: "read", arguments: { path: "a" } } }] },
      { role: "tool", tool_name: "read", content: "file body" }
    ]);
  });
});

describe("rewrite guard", () => {
  it("refuses a third full rewrite of the same file and keeps the run going", async () => {
    const write = (content: string) => ({ toolCalls: [{ name: "write", arguments: { path: "s.c", content } }] });
    const { requests, makeRunner } = await setup([write("v1"), write("v2"), write("v3"), { content: "Stopped rewriting." }]);

    const events = await drain(makeRunner().run("make s.c"));

    expect(events.at(-1)).toMatchObject({ type: "final", workState: "done" });
    const lastTool = (requests[3] ?? []).filter((message) => message.role === "tool").at(-1);
    expect(lastTool?.content).toContain("Refused");
  });

  it("counts tokens across the whole turn, not per model call", async () => {
    const { makeRunner } = await setup([{ toolCalls: [{ name: "glob", arguments: { pattern: "*" } }] }, { content: "done" }]);
    const runner = makeRunner();
    await drain(runner.run("look"));
    expect((runner as unknown as { turnTokens: number }).turnTokens).toBe(2);
  });
});
