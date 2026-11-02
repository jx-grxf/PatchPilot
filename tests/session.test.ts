import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSessionRecap, buildSessionResumeContext, listIndexedSessions, listWorkspaceSessions, readAgentEvents, readSessionEvents, SessionStore, type AgentSessionEvent } from "../src/core/session.js";

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

  it("builds a concise recap from tasks, tool results, outcomes, and approvals", () => {
    const recap = buildSessionRecap([
      {
        type: "run.started",
        runId: "run-1",
        task: "fix the layout",
        provider: "codex",
        model: "gpt-5.5",
        startedAt: "2026-06-13T10:00:00.000Z"
      },
      {
        type: "tool.completed",
        runId: "run-1",
        toolCallId: "tool-1",
        tool: "write_file",
        ok: true,
        summary: "updated the transcript layout",
        workState: "editing",
        createdAt: "2026-06-13T10:00:01.000Z"
      },
      {
        type: "approval.requested",
        runId: "run-1",
        request: {
          id: "approval-1",
          tool: "write_file",
          arguments: {},
          permission: "write",
          risk: "medium",
          preview: "write layout file"
        },
        decision: "allow_once",
        createdAt: "2026-06-13T10:00:01.000Z"
      },
      {
        type: "run.completed",
        runId: "run-1",
        message: "layout fixed and tested",
        completedAt: "2026-06-13T10:00:02.000Z"
      }
    ]);

    expect(recap.text).toContain("1 task");
    expect(recap.text).toContain("1 completed");
    expect(recap.text).toContain("1 approved");
    expect(recap.detail).toContain("fix the layout");
    expect(recap.detail).toContain("updated the transcript layout");
    expect(recap.detail).toContain("layout fixed and tested");
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

  it("lands concurrent appends as whole lines and keeps the index consistent", async () => {
    const store = new SessionStore({ workspace: tempRoot, sessionId: "busy" });
    await store.create();
    const sessionPath = SessionStore.workspaceSessionPath(tempRoot, "busy");
    const payload = "x".repeat(20_000);

    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        store.append(
          index % 2 === 0
            ? { type: "agent.entry", id: `agent-${index}`, entry: { type: "user", text: payload } }
            : { type: "run.started", runId: `run-${index}`, task: `task ${index}`, provider: "ollama", model: "m", startedAt: "2026-05-14T10:00:00.000Z" }
        )
      )
    );

    const lines = (await readFile(sessionPath, "utf8")).split("\n").filter(Boolean);
    expect(lines).toHaveLength(41);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    const indexed = await listIndexedSessions();
    expect(indexed.filter((session) => session.sessionId === "busy")).toHaveLength(1);
    expect(indexed[0]?.lastTask).toMatch(/^task \d+$/);
  });

  it("keeps appending after a failed append", async () => {
    const store = new SessionStore({ workspace: tempRoot, sessionId: "recovers" });
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const broken = store.append({ type: "todo.updated", runId: "r", items: circular as never, summary: "", createdAt: "2026-05-14T10:00:00.000Z" });
    const fine = store.append({ type: "session.created", sessionId: "recovers", workspace: tempRoot, createdAt: "2026-05-14T10:00:01.000Z" });

    await expect(broken).rejects.toThrow();
    await expect(fine).resolves.toBeUndefined();
    await expect(store.loadEvents()).resolves.toHaveLength(1);
  });

  it("keeps agent events out of resume context, summaries and the session list", async () => {
    const store = new SessionStore({ workspace: tempRoot, sessionId: "with-agents" });
    await store.create();
    await store.append({ type: "run.started", runId: "run-1", task: "review the repo", provider: "ollama", model: "m", startedAt: "2026-05-14T10:00:00.000Z" });
    const started: AgentSessionEvent = { type: "agent.started", id: "agent-1", agentType: "explore", description: "look around", prompt: "go", startedAt: 1_700_000_000_000 };
    await store.append(started);
    for (let index = 0; index < 30; index += 1) {
      await store.append({ type: "agent.entry", id: "agent-1", entry: { type: "user", text: `note ${index}` } });
    }
    await store.append({
      type: "agent.finished",
      id: "agent-1",
      state: "ok",
      durationMs: 5,
      promptTokens: 1,
      outputTokens: 2,
      toolCalls: 3,
      transcript: null,
      conversation: []
    });

    const context = await buildSessionResumeContext(tempRoot, "with-agents");
    expect(context).toContain("review the repo");
    expect(context).not.toContain("agent-1");
    await expect(store.summary()).resolves.toMatchObject({ lastTask: "review the repo" });
    expect((await listWorkspaceSessions(tempRoot)).map((session) => session.sessionId)).toContain("with-agents");
    expect((await listIndexedSessions())[0]?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    await expect(store.loadEvents()).resolves.toHaveLength(2);
  });
});

describe("readAgentEvents", () => {
  it("returns agent events in order, skips unrelated ones and a truncated last line", async () => {
    const store = new SessionStore({ workspace: tempRoot, sessionId: "agents" });
    await store.create();
    await store.append({ type: "agent.started", id: "agent-1", agentType: "general", description: "d", prompt: "p", startedAt: 1 });
    await store.append({ type: "run.completed", runId: "run-1", message: "done", completedAt: "2026-05-14T10:00:01.000Z" });
    await store.append({ type: "agent.entry", id: "agent-1", entry: { type: "user", text: "hello" } });

    const sessionPath = SessionStore.workspaceSessionPath(tempRoot, "agents");
    await appendFile(sessionPath, '{"type":"agent.finished","id":"agent-1","state":"o', "utf8");

    const events = await readAgentEvents(sessionPath);
    expect(events.map((event) => event.type)).toEqual(["agent.started", "agent.entry"]);
    await expect(readAgentEvents(path.join(tempRoot, "missing.jsonl"))).resolves.toEqual([]);
  });
});
