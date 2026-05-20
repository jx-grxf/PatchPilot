import { describe, expect, it } from "vitest";
import { selectableModels } from "../src/tui/modelSelection.js";

describe("model selection", () => {
  it("matches model display labels as well as provider ids", () => {
    const models = ["flash-lite-id", "gemini-3-flash", "gemini-3-pro"];
    const labels = new Map([
      ["flash-lite-id", "3.1 Flash-Lite (flash-lite-id)"],
      ["gemini-3-flash", "3.5 Flash (gemini-3-flash)"],
      ["gemini-3-pro", "3.1 Pro (gemini-3-pro)"]
    ]);

    expect(selectableModels("flash-lite", models, (model) => labels.get(model) ?? model)[0]).toBe("flash-lite-id");
    expect(selectableModels("3.5", models, (model) => labels.get(model) ?? model)[0]).toBe("gemini-3-flash");
  });
});
