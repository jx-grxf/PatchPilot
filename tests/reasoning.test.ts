import { describe, expect, it } from "vitest";
import { formatThinkingSupport, getOllamaThinkValue, supportsThinking } from "../src/core/reasoning.js";

describe("model thinking capability", () => {
  it("detects the Ollama families that accept a think parameter", () => {
    expect(supportsThinking("ollama", "qwen3:8b")).toBe(true);
    expect(supportsThinking("ollama", "deepseek-r1:14b")).toBe(true);
    expect(supportsThinking("ollama", "gpt-oss:20b")).toBe(true);
    expect(supportsThinking("ollama", "qwen2.5-coder:7b")).toBe(false);
  });

  it("exposes no thinking switch on OpenAI-compatible servers", () => {
    expect(supportsThinking("local-openai", "qwen3-8b")).toBe(false);
  });

  it("sends nothing when thinking is left on auto", () => {
    expect(getOllamaThinkValue("qwen3:8b", "auto")).toBeUndefined();
    expect(getOllamaThinkValue("qwen3:8b", undefined)).toBeUndefined();
  });

  it("sends nothing for models with no thinking mode", () => {
    expect(getOllamaThinkValue("qwen2.5-coder:7b", "on")).toBeUndefined();
    expect(getOllamaThinkValue("qwen2.5-coder:7b", "off")).toBeUndefined();
  });

  it("maps on and off to a boolean for boolean-think models", () => {
    expect(getOllamaThinkValue("qwen3:8b", "on")).toBe(true);
    expect(getOllamaThinkValue("qwen3:8b", "off")).toBe(false);
  });

  it("uses graded effort for gpt-oss, which cannot be silenced", () => {
    expect(getOllamaThinkValue("gpt-oss:20b", "on")).toBe("high");
    expect(getOllamaThinkValue("gpt-oss:20b", "off")).toBe("low");
  });

  it("says plainly when a model has no thinking mode", () => {
    expect(formatThinkingSupport("ollama", "qwen2.5-coder:7b", "on")).toContain("no thinking mode");
    expect(formatThinkingSupport("ollama", "qwen3:8b", "auto")).toBe("model default");
    expect(formatThinkingSupport("ollama", "gpt-oss:20b", "off")).toContain("cannot be fully disabled");
  });
});
