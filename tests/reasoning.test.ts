import { describe, expect, it } from "vitest";
import {
  formatReasoningSupport,
  getGeminiThinkingConfig,
  getNvidiaReasoningEffort,
  getOllamaThinkValue,
  getOpenRouterReasoningConfig,
  resolveProviderReasoning
} from "../src/core/reasoning.js";

describe("provider reasoning capabilities", () => {
  it("maps Gemini 2.5 Flash off to thinkingBudget 0", () => {
    expect(getGeminiThinkingConfig("gemini-2.5-flash", "none")).toEqual({
      thinkingBudget: 0
    });
  });

  it("does not pretend Gemini Pro thinking can be disabled", () => {
    expect(getGeminiThinkingConfig("gemini-2.5-pro", "none")).toBeUndefined();
    expect(resolveProviderReasoning({ provider: "gemini", model: "gemini-2.5-pro", requested: "none" })).toBeUndefined();
  });

  it("maps Gemini 3 effort to thinkingLevel and caps xhigh", () => {
    expect(getGeminiThinkingConfig("gemini-3-pro-preview", "xhigh")).toEqual({
      thinkingLevel: "high"
    });
  });

  it("uses OpenRouter's normalized reasoning object including none", () => {
    expect(getOpenRouterReasoningConfig("none")).toEqual({
      effort: "none",
      exclude: true
    });
  });

  it("only sets Ollama think for thinking-capable model families", () => {
    expect(getOllamaThinkValue("qwen3:8b", "none")).toBe(false);
    expect(getOllamaThinkValue("gpt-oss:20b", "xhigh")).toBe("high");
    expect(getOllamaThinkValue("qwen2.5-coder:7b", "high")).toBeUndefined();
  });

  it("limits NVIDIA reasoning_effort to supported GPT-OSS NIM models", () => {
    expect(getNvidiaReasoningEffort("openai/gpt-oss-120b", "xhigh")).toBe("high");
    expect(getNvidiaReasoningEffort("meta/llama-3.1-70b-instruct", "high")).toBeUndefined();
  });

  it("formats unsupported reasoning clearly for the TUI", () => {
    expect(formatReasoningSupport("nvidia", "meta/llama-3.1-70b-instruct", "high")).toContain("not supported");
  });
});
