import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSessionResumeContext, listIndexedSessions, listWorkspaceSessions, readSessionEvents, SessionStore } from "../src/core/session.js";

let tempRoot = "";
let previousConfigDir: string | undefined;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), "patchpilot-session-"));
  previousConfigDir = process.env.PATCHPILOT_CONFIG_DIR;
  process.env.PATCHPILOT_CONFIG_DIR = path.join(tempRoot, "config");
});

afterEach(async () => {
  if (previousConfigDir === undefined) {
    delete process.env.PATCHPILOT_CONFIG_DIR;
  } else {
    process.env.PATCHPILOT_CONFIG_DIR = previousConfigDir;
  }
  await rm(tempRoot, {
    recursive: true,
    force: true
  });
});

describe("SessionStore", () => {
  it("appends session events and summarizes runs", async () => {
    const store = new SessionStore({
      workspace: tempRoot,
      sessionId: "test-session"
    });

    await store.create();
    await store.append({
      type: "run.started",
      runId: "run-1",
      task: "inspect repo",
      provider: "ollama",
      model: "qwen2.5-coder:7b",
      startedAt: "2026-05-14T10:00:00.000Z"
    });
    await store.append({
      type: "run.completed",
      runId: "run-1",
      message: "done",
      completedAt: "2026-05-14T10:00:01.000Z"
    });

    await expect(store.loadEvents()).resolves.toHaveLength(3);
    await expect(store.summary()).resolves.toMatchObject({
      sessionId: "test-session",
      lastTask: "inspect repo",
      provider: "ollama",
      model: "qwen2.5-coder:7b",
      updatedAt: "2026-05-14T10:00:01.000Z"
    });
  });

  it("lists workspace sessions and skips corrupted jsonl lines", async () => {
    const store = new SessionStore({
      workspace: tempRoot,
      sessionId: "recoverable"
    });
    await store.create();

    const sessionPath = SessionStore.workspaceSessionPath(tempRoot, "recoverable");
    await import("node:fs/promises").then(({ appendFile }) => appendFile(sessionPath, "not-json\n", "utf8"));
    const events = await readSessionEvents(sessionPath);
    expect(events).toHaveLength(1);

    const sessions = await listWorkspaceSessions(tempRoot);
    expect(sessions.map((session) => session.sessionId)).toContain("recoverable");
  });

  it("builds compact resume context from prior session events", async () => {
    const store = new SessionStore({
      workspace: tempRoot,
      sessionId: "resume-me"
    });

    await store.create();
    await store.append({
      type: "run.started",
      runId: "run-1",
      task: "fix the broken game",
      provider: "gemini-wrapper",
      model: "auto",
      startedAt: "2026-05-18T10:00:00.000Z"
    });
    await store.append({
      type: "run.completed",
      runId: "run-1",
      message: "changed index.html",
      completedAt: "2026-05-18T10:00:02.000Z"
    });

    await expect(buildSessionResumeContext(tempRoot, "resume-me")).resolves.toContain("fix the broken game");
    await expect(buildSessionResumeContext(tempRoot, "resume-me")).resolves.toContain("changed index.html");
  });

  it("stores the global session index in PATCHPILOT_CONFIG_DIR", async () => {
    const store = new SessionStore({
      workspace: tempRoot,
      sessionId: "indexed"
    });
    await store.create();

    const indexPath = path.join(process.env.PATCHPILOT_CONFIG_DIR ?? "", "session-index.json");
    await expect(readFile(indexPath, "utf8")).resolves.toContain("indexed");
    await expect(listIndexedSessions()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: "indexed" })]));
  });
});
