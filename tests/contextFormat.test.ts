import { describe, expect, it } from "vitest";
import { buildContextBlock, formatContextDashboard, summarizeContext } from "../src/core/contextFormat.js";
import { createContextItem } from "../src/core/contextItem.js";

describe("context format helpers", () => {
  it("builds provider-neutral context blocks with pinned items first", () => {
    const block = buildContextBlock({
      sessionId: "session-1",
      autoCompactionEnabled: true,
      updatedAt: "2026-05-21T10:00:00.000Z",
      items: [
        createContextItem({
          id: "turn-1",
          kind: "turn",
          source: "assistant",
          label: "old answer",
          createdAt: "2026-05-21T10:00:00.000Z"
        }),
        createContextItem({
          id: "file-1",
          kind: "pinned_file",
          source: "user",
          label: "briefing.pdf",
          path: "/tmp/briefing.pdf",
          createdAt: "2026-05-21T10:01:00.000Z"
        })
      ]
    });

    expect(block).toContain("Known session context:");
    expect(block.indexOf("pinned_file pinned")).toBeLessThan(block.indexOf("turn"));
    expect(block).toContain("path=/tmp/briefing.pdf");
  });

  it("formats dashboard and summary counts without dropped items", () => {
    const snapshot = {
      sessionId: "session-1",
      autoCompactionEnabled: false,
      updatedAt: "2026-05-21T10:00:00.000Z",
      items: [
        createContextItem({
          id: "artifact-1",
          kind: "artifact",
          source: "tool",
          label: "report.md",
          path: "report.md"
        }),
        createContextItem({
          id: "summary-1",
          kind: "summary",
          source: "session",
          label: "old summary",
          dropped: true
        })
      ]
    };

    expect(formatContextDashboard(snapshot)).toContain("Items: 1 active, 0 pinned");
    expect(formatContextDashboard(snapshot)).toContain("Kinds: artifact=1");
    expect(summarizeContext(snapshot)).toMatchObject({
      activeItems: 1,
      droppedItems: 1,
      autoCompactionEnabled: false
    });
  });
});
