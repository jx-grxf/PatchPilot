import { describe, expect, it } from "vitest";
import { rememberModelDescriptors } from "../src/tui/modelDescriptors.js";
import { defaultModelForProvider } from "../src/tui/modelPicking.js";
import { formatModelLabel, selectableModels } from "../src/tui/modelSelection.js";

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

  it("replaces stale descriptors when the active runtime changes", () => {
    rememberModelDescriptors([{ id: "shared", displayName: "Ollama label" }]);
    expect(formatModelLabel("shared")).toContain("Ollama label");

    rememberModelDescriptors([{ id: "other", displayName: "Local server label" }]);
    expect(formatModelLabel("shared")).toBe("shared");
  });

  it("does not carry a same-named model across provider switches", () => {
    rememberModelDescriptors([{ id: "shared", displayName: "Shared" }]);
    expect(defaultModelForProvider("local-openai", "shared", "ollama")).not.toBe("shared");
    expect(defaultModelForProvider("local-openai", "shared", "local-openai")).toBe("shared");
  });
});
