import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContextStore } from "../src/core/contextStore.js";

let tempRoot = "";

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), "patchpilot-context-"));
});

afterEach(async () => {
  await rm(tempRoot, {
    recursive: true,
    force: true
  });
});

describe("ContextStore", () => {
  it("appends items and mutates state through replayable tombstone records", async () => {
    const store = new ContextStore({
      workspace: tempRoot,
      sessionId: "session-1"
    });

    const attachment = await store.append({
      id: "attachment-1",
      kind: "attachment",
      source: "user",
      label: "Deutsch Referat.pdf",
      path: "/tmp/Deutsch Referat.pdf"
    });
    await store.pin(attachment.id);
    await store.drop(attachment.id);

    await expect(store.loadItems()).resolves.toEqual([
      expect.objectContaining({
        id: "attachment-1",
        pinned: true,
        dropped: true
      })
    ]);

    const log = await readFile(ContextStore.workspaceContextPath(tempRoot, "session-1"), "utf8");
    expect(log).toContain("context.item.appended");
    expect(log).toContain("context.item.pinned");
    expect(log).toContain("context.item.dropped");
  });

  it("clears only unpinned context and records summaries plus auto-compaction state", async () => {
    const store = new ContextStore({
      workspace: tempRoot,
      sessionId: "session-2"
    });

    await store.append({
      id: "file-1",
      kind: "pinned_file",
      source: "user",
      label: "briefing.pdf",
      path: "/tmp/briefing.pdf"
    });
    await store.append({
      id: "turn-1",
      kind: "turn",
      source: "assistant",
      label: "old answer",
      text: "answer"
    });
    await store.recordSummary({
      id: "summary-1",
      label: "older context summary",
      text: "Decisions and verified facts."
    });
    await store.setAutoCompaction(true);
    await store.clear();

    const snapshot = await store.snapshot();
    expect(snapshot.autoCompactionEnabled).toBe(true);
    expect(snapshot.items.find((item) => item.id === "file-1")).toMatchObject({
      pinned: true,
      dropped: false
    });
    expect(snapshot.items.find((item) => item.id === "turn-1")).toMatchObject({
      dropped: true
    });
    expect(snapshot.items.find((item) => item.id === "summary-1")).toMatchObject({
      kind: "summary",
      dropped: true
    });
  });

  it("falls back to log replay when the derived snapshot is corrupt", async () => {
    const store = new ContextStore({
      workspace: tempRoot,
      sessionId: "session-3"
    });
    await store.append({
      id: "artifact-1",
      kind: "artifact",
      source: "tool",
      label: "report.md",
      path: "report.md"
    });

    await writeFile(ContextStore.workspaceSnapshotPath(tempRoot, "session-3"), "{bad json", "utf8");

    await expect(store.snapshot()).resolves.toMatchObject({
      sessionId: "session-3",
      eventCount: 1,
      items: [expect.objectContaining({ id: "artifact-1" })]
    });
  });

  it("bootstraps context from existing session events without duplicating event keys", async () => {
    const store = new ContextStore({
      workspace: tempRoot,
      sessionId: "session-4"
    });
    const events = [
      {
        type: "run.started" as const,
        runId: "run-1",
        task: "summarize the PDF",
        provider: "gemini-wrapper" as const,
        model: "auto",
        startedAt: "2026-05-21T10:00:00.000Z"
      },
      {
        type: "run.completed" as const,
        runId: "run-1",
        message: "summary done",
        completedAt: "2026-05-21T10:00:01.000Z"
      }
    ];

    await expect(store.bootstrapFromSession(events)).resolves.toHaveLength(2);
    await expect(store.bootstrapFromSession(events)).resolves.toHaveLength(0);
    await expect(store.loadItems()).resolves.toHaveLength(2);
  });

  it("skips corrupt JSONL lines while replaying the source log", async () => {
    const store = new ContextStore({
      workspace: tempRoot,
      sessionId: "session-5"
    });
    await store.append({
      id: "turn-1",
      kind: "turn",
      source: "user",
      label: "hello"
    });
    await appendFile(ContextStore.workspaceContextPath(tempRoot, "session-5"), "not-json\n", "utf8");

    await expect(store.loadItems()).resolves.toHaveLength(1);
  });
});
