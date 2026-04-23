import { describe, expect, it } from "vitest";
import { describeComputeTarget, isLocalComputeTarget } from "../src/core/compute.js";

describe("compute target classification", () => {
  it("treats localhost Ollama as local compute", () => {
    expect(describeComputeTarget("local")).toMatchObject({
      kind: "local",
      url: "http://127.0.0.1:11434"
    });
    expect(isLocalComputeTarget("http://localhost:11434")).toBe(true);
  });

  it("treats LAN Ollama hosts as remote compute", () => {
    expect(describeComputeTarget("192.168.1.50")).toMatchObject({
      kind: "remote",
      url: "http://192.168.1.50:11434",
      host: "192.168.1.50:11434"
    });
  });
});
