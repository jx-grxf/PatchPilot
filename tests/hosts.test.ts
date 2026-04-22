import { describe, expect, it } from "vitest";
import { getOllamaHostCandidates, normalizeOllamaUrl } from "../src/tui/hosts.js";

describe("normalizeOllamaUrl", () => {
  it("normalizes local aliases", () => {
    expect(normalizeOllamaUrl("local")).toBe("http://127.0.0.1:11434");
  });

  it("adds http scheme to host inputs", () => {
    expect(normalizeOllamaUrl("192.168.1.50:11434")).toBe("http://192.168.1.50:11434");
  });

  it("keeps candidate suggestions to explicit hosts", () => {
    expect(getOllamaHostCandidates("http://192.168.1.50:11434").every((host) => !host.label.startsWith("lan-"))).toBe(true);
  });
});
