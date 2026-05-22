import { describe, expect, it } from "vitest";
import { formatCompactTokens, getModelHint } from "../src/tui/format.js";

describe("formatCompactTokens", () => {
  it("shows raw counts below 1000", () => {
    expect(formatCompactTokens(0)).toBe("0");
    expect(formatCompactTokens(42)).toBe("42");
    expect(formatCompactTokens(999)).toBe("999");
  });

  it("shows one decimal in the low-thousands range", () => {
    expect(formatCompactTokens(6100)).toBe("6.1k");
    expect(formatCompactTokens(1000)).toBe("1.0k");
  });

  it("rounds to whole-k above ten thousand", () => {
    expect(formatCompactTokens(175_239)).toBe("175k");
    expect(formatCompactTokens(12_500)).toBe("13k");
  });

  it("switches to millions past 1M and clamps junk input", () => {
    expect(formatCompactTokens(2_400_000)).toBe("2.4M");
    expect(formatCompactTokens(-5)).toBe("0");
    expect(formatCompactTokens(Number.NaN)).toBe("0");
  });
});

describe("getModelHint", () => {
  it("recognizes explicit coding models", () => {
    expect(getModelHint("qwen2.5-coder:7b")).toEqual({
      text: "coding model ready",
      color: "green"
    });
    expect(getModelHint("abacusai/dracarys-llama-3.1-70b-instruct")).toEqual({
      text: "coding model ready",
      color: "green"
    });
  });

  it("does not warn for large agent-capable instruct models", () => {
    expect(getModelHint("meta/llama-3.1-70b-instruct")).toEqual({
      text: "agent-capable model selected",
      color: "green"
    });
    expect(getModelHint("nvidia/llama-3.3-nemotron-super-49b-v1.5")).toEqual({
      text: "agent-capable model selected",
      color: "green"
    });
  });

  it("keeps the weak warning for unknown general models", () => {
    expect(getModelHint("small-chat-model")).toEqual({
      text: "general model selected; coding reliability may be weak",
      color: "yellow"
    });
  });
});
