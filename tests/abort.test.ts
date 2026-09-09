import { describe, expect, it } from "vitest";
import { AgentRunner } from "../src/core/agent.js";
import { setModelCapabilities } from "../src/core/capability.js";
import type { ModelChatOptions, ModelChatResult, ModelClient } from "../src/core/types.js";

/**
 * Stopping a run has to actually stop it. A run that keeps burning minutes
 * after the user pressed escape is worse than one that never started.
 */

function telemetry(): ModelChatResult["telemetry"] {
  return {
    promptTokens: 1,
    cachedPromptTokens: 0,
    cacheWriteTokens: 0,
    responseTokens: 1,
    totalTokens: 2,
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

/** A model that streams slowly and honours the abort signal, like a real one. */
function slowClient(options: { onCall?: () => void } = {}): ModelClient {
  return {
    async chat(chatOptions: ModelChatOptions): Promise<ModelChatResult> {
      options.onCall?.();
      return await new Promise<ModelChatResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve({
            content: JSON.stringify({ action: "final", message: "done" }),
            telemetry: telemetry()
          });
        }, 5000);

        chatOptions.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("The operation was aborted."));
          },
          { once: true }
        );
      });
    },
    async listModels(): Promise<string[]> {
      return [];
    }
  };
}

function runner(client: ModelClient, signal: AbortSignal): AgentRunner {
  setModelCapabilities("ollama", "test-model", { nativeToolCalls: false, detail: "test" });
  return new AgentRunner({
    provider: "ollama",
    model: "test-model",
    ollamaUrl: "http://127.0.0.1:11434",
    workspace: "/tmp",
    allowWrite: false,
    allowShell: false,
    maxSteps: 8,
    thinkingMode: "fixed",
    thinking: "auto",
    subagents: false,
    signal,
    client
  });
}

describe("aborting a run", () => {
  it("stops within a second of the signal firing", async () => {
    const controller = new AbortController();
    const events: string[] = [];
    const startedAt = Date.now();

    setTimeout(() => controller.abort(), 100);

    for await (const event of runner(slowClient(), controller.signal).run("do something slow")) {
      events.push(event.type);
    }

    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(events).toContain("final");
  });

  it("does not start another model call after the abort", async () => {
    const controller = new AbortController();
    let calls = 0;

    setTimeout(() => controller.abort(), 100);
    for await (const _event of runner(slowClient({ onCall: () => (calls += 1) }), controller.signal).run("task")) {
      void _event;
    }

    // The in-flight call may already have been issued; a second one means the
    // loop kept going after the user asked it to stop.
    expect(calls).toBe(1);
  });

  it("stops immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;

    const events: string[] = [];
    for await (const event of runner(slowClient({ onCall: () => (calls += 1) }), controller.signal).run("task")) {
      events.push(event.type);
    }

    expect(calls).toBe(0);
    expect(events).toContain("final");
  });

  it("reports the stop as a normal outcome, not as an error", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    const messages: string[] = [];
    for await (const event of runner(slowClient(), controller.signal).run("task")) {
      if (event.type === "final" || event.type === "error") {
        messages.push(`${event.type}: ${event.message}`);
      }
    }

    expect(messages.some((message) => message.startsWith("final:"))).toBe(true);
    expect(messages.some((message) => message.startsWith("error:"))).toBe(false);
  });
});
