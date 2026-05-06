import { describe, expect, it } from "vitest";
import { getModelHint } from "../src/tui/format.js";

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
