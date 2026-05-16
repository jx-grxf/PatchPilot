import { describe, expect, it } from "vitest";
import { classifyOllamaHost, getOllamaHostCandidates, normalizeOllamaUrl } from "../src/tui/hosts.js";

describe("normalizeOllamaUrl", () => {
  it("normalizes local aliases", () => {
    expect(normalizeOllamaUrl("local")).toBe("http://127.0.0.1:11434");
    expect(normalizeOllamaUrl("LOCAL")).toBe("http://127.0.0.1:11434");
  });

  it("adds http scheme to host inputs", () => {
    expect(normalizeOllamaUrl("192.168.1.50:11434")).toBe("http://192.168.1.50:11434");
  });

  it("adds the default Ollama port when only a host is entered", () => {
    expect(normalizeOllamaUrl("192.168.1.50")).toBe("http://192.168.1.50:11434");
  });

  it("maps server bind addresses back to localhost for client requests", () => {
    expect(normalizeOllamaUrl("0.0.0.0:11434")).toBe("http://127.0.0.1:11434");
  });

  it("keeps candidate suggestions to explicit hosts", () => {
    expect(getOllamaHostCandidates("http://192.168.1.50:11434").every((host) => !host.label.startsWith("lan-"))).toBe(true);
  });

  it("classifies Tailscale hosts separately from LAN hosts", () => {
    expect(classifyOllamaHost("http://100.88.10.2:11434")).toBe("tailscale");
    expect(classifyOllamaHost("http://builder.example.ts.net:11434")).toBe("tailscale");
    expect(classifyOllamaHost("http://192.168.1.50:11434")).toBe("lan");
    expect(classifyOllamaHost("http://172.16.1.20:11434")).toBe("lan");
  });
});
