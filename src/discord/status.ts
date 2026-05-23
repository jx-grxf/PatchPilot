import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PatchPilotDiscordConfig } from "./config.js";
import { listDiscordSessionRecords, type DiscordSessionRecord } from "./sessions.js";

export type DiscordRuntimeStatus = {
  enabled: boolean;
  pid: number | null;
  startedAt?: string;
  updatedAt: string;
  botUser?: string;
  guildCount: number;
  allowedChannelCount: number;
  adminUserCount: number;
  activeSessions: number;
  sessions: DiscordSessionRecord[];
  provider: string;
  model: string;
  stateDir: string;
  logsDir: string;
  lastRun?: {
    sessionId: string;
    workspace: string;
    prompt: string;
    summary?: string;
    completedAt?: string;
  };
  lastError?: string;
};

export async function writeDiscordRuntimeStatus(config: PatchPilotDiscordConfig, patch: Partial<DiscordRuntimeStatus>): Promise<DiscordRuntimeStatus> {
  const existing = await readDiscordRuntimeStatus(config.stateDir).catch(() => null);
  const sessions = await listDiscordSessionRecords(config.stateDir).catch(() => existing?.sessions ?? []);
  const next: DiscordRuntimeStatus = {
    ...existing,
    ...patch,
    enabled: config.enabled,
    pid: process.pid,
    startedAt: existing?.startedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    guildCount: config.guildIds.length,
    allowedChannelCount: config.allowedChannelIds.length,
    adminUserCount: config.adminUserIds.length,
    activeSessions: sessions.length,
    sessions: sessions.slice(0, 20),
    provider: config.provider,
    model: config.model,
    stateDir: config.stateDir,
    logsDir: config.logsDir
  };
  await mkdir(config.stateDir, { recursive: true });
  await writeFile(discordStatusPath(config.stateDir), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export async function readDiscordRuntimeStatus(stateDir: string): Promise<DiscordRuntimeStatus | null> {
  const content = await readFile(discordStatusPath(stateDir), "utf8").catch(() => "");
  if (!content.trim()) {
    return null;
  }
  try {
    return JSON.parse(content) as DiscordRuntimeStatus;
  } catch {
    return null;
  }
}

export function formatDiscordStatus(status: DiscordRuntimeStatus | null, options?: { launchd?: string }): string {
  if (!status) {
    return [
      "Discord daemon status: no runtime heartbeat found.",
      options?.launchd ? `launchd: ${options.launchd}` : "",
      "Run patchpilot discord status for config checks, or patchpilot discord install-service after setup."
    ].filter(Boolean).join("\n");
  }

  return [
    `Discord daemon: ${status.enabled ? "enabled" : "disabled"}${status.pid ? ` · pid ${status.pid}` : ""}`,
    `updated: ${status.updatedAt}`,
    status.botUser ? `bot: ${status.botUser}` : "",
    `model: ${status.provider}/${status.model}`,
    `guilds: ${status.guildCount || "any"} · allowed channels: ${status.allowedChannelCount || "any"} · admin users: ${status.adminUserCount || "any"}`,
    `sessions: ${status.activeSessions}`,
    status.lastRun ? `last run: ${status.lastRun.sessionId} · ${status.lastRun.workspace} · ${status.lastRun.summary ?? status.lastRun.prompt}` : "",
    status.lastError ? `last error: ${status.lastError}` : "",
    `state: ${status.stateDir}`,
    `logs: ${status.logsDir}`,
    options?.launchd ? `launchd: ${options.launchd}` : ""
  ].filter(Boolean).join("\n");
}

function discordStatusPath(stateDir: string): string {
  return path.join(stateDir, "status.json");
}
