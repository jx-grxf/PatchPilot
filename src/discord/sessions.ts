import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type DiscordSessionScope = "dm" | "guild-channel" | "guild-thread";

export type DiscordSessionKeyInput = {
  guildId?: string | null;
  channelId: string;
  threadId?: string | null;
  userId: string;
};

export type DiscordSessionRecord = {
  key: string;
  sessionId: string;
  workspace: string;
  scope: DiscordSessionScope;
  guildId?: string;
  channelId: string;
  threadId?: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
  lastRunId?: string;
  lastPrompt?: string;
};

type DiscordSessionStoreFile = {
  sessions: DiscordSessionRecord[];
};

export function buildDiscordSessionKey(input: DiscordSessionKeyInput): string {
  if (!input.guildId) {
    return `discord:dm:${input.userId}`;
  }

  if (input.threadId) {
    return `discord:guild:${input.guildId}:thread:${input.threadId}:user:${input.userId}`;
  }

  return `discord:guild:${input.guildId}:channel:${input.channelId}:user:${input.userId}`;
}

export function classifyDiscordSession(input: DiscordSessionKeyInput): DiscordSessionScope {
  if (!input.guildId) {
    return "dm";
  }
  return input.threadId ? "guild-thread" : "guild-channel";
}

export async function upsertDiscordSessionRecord(params: {
  stateDir: string;
  input: DiscordSessionKeyInput;
  sessionId: string;
  workspace: string;
  runId?: string;
  prompt?: string;
}): Promise<DiscordSessionRecord> {
  const storePath = discordSessionsPath(params.stateDir);
  const store = await readDiscordSessionStore(storePath);
  const key = buildDiscordSessionKey(params.input);
  const now = new Date().toISOString();
  const existing = store.sessions.find((session) => session.key === key && session.workspace === params.workspace);
  const nextRecord: DiscordSessionRecord = {
    ...existing,
    key,
    sessionId: params.sessionId,
    workspace: params.workspace,
    scope: classifyDiscordSession(params.input),
    guildId: params.input.guildId ?? undefined,
    channelId: params.input.channelId,
    threadId: params.input.threadId ?? undefined,
    userId: params.input.userId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastRunId: params.runId ?? existing?.lastRunId,
    lastPrompt: params.prompt ?? existing?.lastPrompt
  };
  const sessions = [
    nextRecord,
    ...store.sessions.filter((session) => !(session.key === key && session.workspace === params.workspace))
  ].slice(0, 200);
  await mkdir(path.dirname(storePath), { recursive: true });
  await writeFile(storePath, `${JSON.stringify({ sessions }, null, 2)}\n`, "utf8");
  return nextRecord;
}

export async function listDiscordSessionRecords(stateDir: string): Promise<DiscordSessionRecord[]> {
  return (await readDiscordSessionStore(discordSessionsPath(stateDir))).sessions;
}

export async function findDiscordSessionRecord(params: {
  stateDir: string;
  input: DiscordSessionKeyInput;
  workspace: string;
}): Promise<DiscordSessionRecord | null> {
  const key = buildDiscordSessionKey(params.input);
  const store = await readDiscordSessionStore(discordSessionsPath(params.stateDir));
  return store.sessions.find((session) => session.key === key && session.workspace === params.workspace) ?? null;
}

function discordSessionsPath(stateDir: string): string {
  return path.join(stateDir, "sessions.json");
}

async function readDiscordSessionStore(storePath: string): Promise<DiscordSessionStoreFile> {
  const content = await readFile(storePath, "utf8").catch(() => "");
  if (!content.trim()) {
    return { sessions: [] };
  }
  try {
    const parsed = JSON.parse(content) as Partial<DiscordSessionStoreFile>;
    return {
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions.filter(isDiscordSessionRecord) : []
    };
  } catch {
    return { sessions: [] };
  }
}

function isDiscordSessionRecord(value: unknown): value is DiscordSessionRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Partial<DiscordSessionRecord>;
  return typeof record.key === "string" && typeof record.sessionId === "string" && typeof record.workspace === "string";
}
