import { describe, expect, it } from "vitest";
import { createContextItem, isContextItem, normalizeContextItem } from "../src/core/contextItem.js";

describe("ContextItem", () => {
  it("creates typed context items with stable defaults", () => {
    const item = createContextItem({
      kind: "attachment",
      source: "user",
      label: "Deutsch Referat.pdf",
      path: "/tmp/Deutsch Referat.pdf"
    });

    expect(item).toMatchObject({
      kind: "attachment",
      source: "user",
      label: "Deutsch Referat.pdf",
      path: "/tmp/Deutsch Referat.pdf",
      priority: 80,
      pinned: false,
      dropped: false
    });
    expect(item.id).toMatch(/^attachment-/);
    expect(item.tokenEstimate).toBeGreaterThan(0);
    expect(isContextItem(item)).toBe(true);
  });

  it("pins pinned_file items and clamps invalid numeric fields", () => {
    const item = normalizeContextItem({
      id: "file-1",
      kind: "pinned_file",
      source: "session",
      label: "notes.md",
      createdAt: "2026-05-21T10:00:00.000Z",
      tokenEstimate: -10,
      priority: 500,
      expiresAfterTurns: 2.8
    });

    expect(item.pinned).toBe(true);
    expect(item.tokenEstimate).toBe(0);
    expect(item.priority).toBe(100);
    expect(item.expiresAfterTurns).toBe(2);
  });
});
