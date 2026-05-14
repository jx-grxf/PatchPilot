import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ModelProvider, SessionEvent } from "./types.js";

export type SessionSummary = {
  sessionId: string;
  workspace: string;
  createdAt: string;
  updatedAt: string;
  lastTask?: string;
  provider?: ModelProvider;
  model?: string;
};

type SessionIndex = {
  sessions: SessionSummary[];
};

export class SessionStore {
  readonly workspace: string;
  readonly sessionId: string;
  private readonly sessionDir: string;
  private readonly sessionPath: string;
  private readonly indexPath: string;

  constructor(options: { workspace: string; sessionId?: string }) {
    this.workspace = path.resolve(options.workspace);
    this.sessionId = options.sessionId ?? createSessionId();
    this.sessionDir = path.join(this.workspace, ".patchpilot", "sessions");
    this.sessionPath = path.join(this.sessionDir, `${this.sessionId}.jsonl`);
    this.indexPath = path.join(homedir(), ".patchpilot", "session-index.json");
  }

  static workspaceSessionPath(workspace: string, sessionId: string): string {
    return path.join(path.resolve(workspace), ".patchpilot", "sessions", `${sessionId}.jsonl`);
  }

  async create(): Promise<void> {
    await this.append({
      type: "session.created",
      sessionId: this.sessionId,
      workspace: this.workspace,
      createdAt: new Date().toISOString()
    });
  }

  async append(event: SessionEvent): Promise<void> {
    await mkdir(this.sessionDir, {
      recursive: true
    });
    await appendFile(this.sessionPath, `${JSON.stringify(event)}\n`, "utf8");
    await this.upsertIndex(event);
  }

  async loadEvents(): Promise<SessionEvent[]> {
    return await readSessionEvents(this.sessionPath);
  }

  async summary(): Promise<SessionSummary> {
    return summarizeEvents(await this.loadEvents(), this.sessionId, this.workspace);
  }

  private async upsertIndex(event: SessionEvent): Promise<void> {
    const index = await readIndex(this.indexPath);
    const currentSummary = await this.summary().catch(() => ({
      sessionId: this.sessionId,
      workspace: this.workspace,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }));
    const updatedSummary = {
      ...currentSummary,
      ...summaryPatchFromEvent(event),
      updatedAt: eventTimestamp(event)
    };
    const sessions = [updatedSummary, ...index.sessions.filter((session) => session.sessionId !== this.sessionId)].slice(0, 80);
    await mkdir(path.dirname(this.indexPath), {
      recursive: true
    });
    await writeFile(this.indexPath, `${JSON.stringify({ sessions }, null, 2)}\n`, "utf8");
  }
}

export async function readSessionEvents(sessionPath: string): Promise<SessionEvent[]> {
  const content = await readFile(sessionPath, "utf8").catch(() => "");
  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as SessionEvent];
      } catch {
        return [];
      }
    });
}

export async function listWorkspaceSessions(workspace: string): Promise<SessionSummary[]> {
  const sessionDir = path.join(path.resolve(workspace), ".patchpilot", "sessions");
  const entries = await readdir(sessionDir).catch(() => []);
  const summaries = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".jsonl"))
      .map(async (entry) => {
        const sessionId = entry.replace(/\.jsonl$/, "");
        return summarizeEvents(await readSessionEvents(path.join(sessionDir, entry)), sessionId, path.resolve(workspace));
      })
  );
  return summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function listIndexedSessions(): Promise<SessionSummary[]> {
  const index = await readIndex(path.join(homedir(), ".patchpilot", "session-index.json"));
  return index.sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function loadSessionSummary(workspace: string, sessionId: string): Promise<SessionSummary> {
  return summarizeEvents(await readSessionEvents(SessionStore.workspaceSessionPath(workspace, sessionId)), sessionId, path.resolve(workspace));
}

function summarizeEvents(events: SessionEvent[], sessionId: string, workspace: string): SessionSummary {
  const created = events.find((event) => event.type === "session.created");
  const summary: SessionSummary = {
    sessionId,
    workspace,
    createdAt: created?.type === "session.created" ? created.createdAt : new Date(0).toISOString(),
    updatedAt: events.length > 0 ? eventTimestamp(events[events.length - 1] as SessionEvent) : new Date(0).toISOString()
  };

  for (const event of events) {
    Object.assign(summary, summaryPatchFromEvent(event));
  }

  return summary;
}

async function readIndex(indexPath: string): Promise<SessionIndex> {
  const content = await readFile(indexPath, "utf8").catch(() => "");
  if (!content.trim()) {
    return {
      sessions: []
    };
  }

  try {
    const parsed = JSON.parse(content) as Partial<SessionIndex>;
    return {
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : []
    };
  } catch {
    return {
      sessions: []
    };
  }
}

function summaryPatchFromEvent(event: SessionEvent): Partial<SessionSummary> {
  if (event.type === "run.started") {
    return {
      lastTask: event.task,
      provider: event.provider,
      model: event.model
    };
  }

  return {};
}

function eventTimestamp(event: SessionEvent): string {
  if ("createdAt" in event) {
    return event.createdAt;
  }

  if ("startedAt" in event) {
    return event.startedAt;
  }

  if ("completedAt" in event) {
    return event.completedAt;
  }

  if ("failedAt" in event) {
    return event.failedAt;
  }

  return new Date().toISOString();
}

function createSessionId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
  return `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}
