import path from "node:path";
import { z } from "zod";
import { getPatchPilotConfigDir } from "../core/env.js";
import { defaultCodexModel } from "../core/codex.js";
import { defaultGeminiModel } from "../core/gemini.js";
import { defaultGeminiWrapperModel } from "../core/geminiWrapper.js";
import { normalizeModelProvider, readModelProvider } from "../core/modelClient.js";
import { defaultNvidiaModel } from "../core/nvidia.js";
import { defaultOllamaModel, resolveOllamaBaseUrl } from "../core/ollama.js";
import { defaultOpenRouterModel } from "../core/openrouter.js";
import type { ModelProvider, ProviderReasoningEffort } from "../core/types.js";

export type DiscordWorkspaceConfig = {
  name: string;
  path: string;
};

export type PatchPilotDiscordConfig = {
  enabled: boolean;
  token: string;
  clientId: string;
  guildIds: string[];
  allowedChannelIds: string[];
  adminUserIds: string[];
  workspaces: DiscordWorkspaceConfig[];
  defaultWorkspace: DiscordWorkspaceConfig;
  provider: ModelProvider;
  model: string;
  ollamaUrl: string;
  maxSteps: number;
  reasoningEffort: ProviderReasoningEffort | "adaptive";
  prefix: string | null;
  respondWithoutMention: boolean;
  configDir: string;
  stateDir: string;
  logsDir: string;
};

export type DiscordConfigIssue = {
  name: string;
  ok: boolean;
  details: string;
};

const envSchema = z.object({
  PATCHPILOT_EXPERIMENTAL_DISCORD: z.string().optional(),
  PATCHPILOT_DISCORD_TOKEN: z.string().optional(),
  PATCHPILOT_DISCORD_CLIENT_ID: z.string().optional(),
  PATCHPILOT_DISCORD_GUILD_IDS: z.string().optional(),
  PATCHPILOT_DISCORD_GUILD_ID: z.string().optional(),
  PATCHPILOT_DISCORD_CHANNEL_IDS: z.string().optional(),
  PATCHPILOT_DISCORD_ALLOWED_CHANNEL_IDS: z.string().optional(),
  PATCHPILOT_DISCORD_ADMIN_USER_IDS: z.string().optional(),
  PATCHPILOT_DISCORD_WORKSPACES: z.string().optional(),
  PATCHPILOT_DISCORD_DEFAULT_WORKSPACE: z.string().optional(),
  PATCHPILOT_PROVIDER: z.string().optional(),
  PATCHPILOT_MODEL_PROVIDER: z.string().optional(),
  PATCHPILOT_MODEL: z.string().optional(),
  PATCHPILOT_OLLAMA_URL: z.string().optional(),
  OLLAMA_HOST: z.string().optional(),
  PATCHPILOT_DISCORD_MAX_STEPS: z.string().optional(),
  PATCHPILOT_REASONING_EFFORT: z.string().optional(),
  PATCHPILOT_DISCORD_PREFIX: z.string().optional(),
  PATCHPILOT_DISCORD_RESPOND_WITHOUT_MENTION: z.string().optional(),
  PATCHPILOT_CONFIG_DIR: z.string().optional()
}).passthrough();

export function readDiscordConfig(env: NodeJS.ProcessEnv = process.env): PatchPilotDiscordConfig {
  const parsedEnv = envSchema.parse(env);
  const provider = readModelProvider(env);
  const configDir = getPatchPilotConfigDir(env);
  const defaultWorkspacePath = path.resolve(parsedEnv.PATCHPILOT_DISCORD_DEFAULT_WORKSPACE?.trim() || process.cwd());
  const workspaces = parseWorkspaces(parsedEnv.PATCHPILOT_DISCORD_WORKSPACES, defaultWorkspacePath);
  const defaultWorkspace = workspaces[0] ?? {
    name: "default",
    path: defaultWorkspacePath
  };

  return {
    enabled: readBoolean(parsedEnv.PATCHPILOT_EXPERIMENTAL_DISCORD, false),
    token: parsedEnv.PATCHPILOT_DISCORD_TOKEN?.trim() ?? "",
    clientId: parsedEnv.PATCHPILOT_DISCORD_CLIENT_ID?.trim() ?? "",
    guildIds: uniqueIds([
      ...parseCsv(parsedEnv.PATCHPILOT_DISCORD_GUILD_IDS),
      ...parseCsv(parsedEnv.PATCHPILOT_DISCORD_GUILD_ID)
    ]),
    allowedChannelIds: uniqueIds([
      ...parseCsv(parsedEnv.PATCHPILOT_DISCORD_ALLOWED_CHANNEL_IDS),
      ...parseCsv(parsedEnv.PATCHPILOT_DISCORD_CHANNEL_IDS)
    ]),
    adminUserIds: uniqueIds(parseCsv(parsedEnv.PATCHPILOT_DISCORD_ADMIN_USER_IDS)),
    workspaces,
    defaultWorkspace,
    provider,
    model: parsedEnv.PATCHPILOT_MODEL?.trim() || defaultModelForProvider(provider),
    ollamaUrl: parsedEnv.PATCHPILOT_OLLAMA_URL?.trim() || parsedEnv.OLLAMA_HOST?.trim() || resolveOllamaBaseUrl(),
    maxSteps: readPositiveInteger(parsedEnv.PATCHPILOT_DISCORD_MAX_STEPS, 8),
    reasoningEffort: readReasoningEffort(parsedEnv.PATCHPILOT_REASONING_EFFORT ?? "medium"),
    prefix: parsedEnv.PATCHPILOT_DISCORD_PREFIX?.trim() || null,
    respondWithoutMention: readBoolean(parsedEnv.PATCHPILOT_DISCORD_RESPOND_WITHOUT_MENTION, false),
    configDir,
    stateDir: path.join(configDir, "discord"),
    logsDir: path.join(configDir, "discord", "logs")
  };
}

export function validateDiscordConfig(config: PatchPilotDiscordConfig): DiscordConfigIssue[] {
  return [
    {
      name: "experimental",
      ok: config.enabled,
      details: config.enabled ? "PATCHPILOT_EXPERIMENTAL_DISCORD enabled" : "Enable with /experimental discord on or PATCHPILOT_EXPERIMENTAL_DISCORD=1"
    },
    {
      name: "client",
      ok: Boolean(config.clientId),
      details: config.clientId ? `client ${shortId(config.clientId)}` : "Missing PATCHPILOT_DISCORD_CLIENT_ID"
    },
    {
      name: "token",
      ok: Boolean(config.token),
      details: config.token ? `token ${redactSecret(config.token)}` : "Missing PATCHPILOT_DISCORD_TOKEN"
    },
    {
      name: "workspace",
      ok: Boolean(config.defaultWorkspace.path),
      details: `${config.defaultWorkspace.name}: ${config.defaultWorkspace.path}`
    }
  ];
}

export function requireDiscordConfig(env: NodeJS.ProcessEnv = process.env): PatchPilotDiscordConfig {
  const config = readDiscordConfig(env);
  const failed = validateDiscordConfig(config).filter((issue) => !issue.ok);
  if (failed.length > 0) {
    throw new Error(failed.map((issue) => `${issue.name}: ${issue.details}`).join("\n"));
  }
  return config;
}

export function resolveDiscordWorkspace(config: PatchPilotDiscordConfig, requestedName?: string | null): DiscordWorkspaceConfig {
  const normalized = requestedName?.trim().toLowerCase();
  if (!normalized) {
    return config.defaultWorkspace;
  }
  const match = config.workspaces.find((workspace) => workspace.name.toLowerCase() === normalized);
  if (!match) {
    throw new Error(`Unknown workspace "${requestedName}". Allowed workspaces: ${config.workspaces.map((workspace) => workspace.name).join(", ")}`);
  }
  return match;
}

export function isDiscordSourceAllowed(config: PatchPilotDiscordConfig, source: {
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
}): boolean {
  const guildAllowed = config.guildIds.length === 0 || (Boolean(source.guildId) && config.guildIds.includes(String(source.guildId)));
  const channelAllowed = config.allowedChannelIds.length === 0 || (Boolean(source.channelId) && config.allowedChannelIds.includes(String(source.channelId)));
  const userAllowed = config.adminUserIds.length === 0 || (Boolean(source.userId) && config.adminUserIds.includes(String(source.userId)));
  return guildAllowed && channelAllowed && userAllowed;
}

export function redactDiscordConfig(config: PatchPilotDiscordConfig): Record<string, unknown> {
  return {
    enabled: config.enabled,
    clientId: shortId(config.clientId),
    token: config.token ? redactSecret(config.token) : "missing",
    guildIds: config.guildIds.map(shortId),
    allowedChannelCount: config.allowedChannelIds.length,
    adminUserCount: config.adminUserIds.length,
    workspaces: config.workspaces.map((workspace) => ({ name: workspace.name, path: workspace.path })),
    provider: config.provider,
    model: config.model,
    prefix: config.prefix ? "enabled" : "disabled",
    respondWithoutMention: config.respondWithoutMention,
    stateDir: config.stateDir,
    logsDir: config.logsDir
  };
}

export function redactSecret(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "missing";
  }
  if (trimmed.length <= 10) {
    return "********";
  }
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

export function shortId(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 8) {
    return trimmed || "-";
  }
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

function parseWorkspaces(value: string | undefined, defaultWorkspacePath: string): DiscordWorkspaceConfig[] {
  const entries = parseCsv(value).map((entry) => {
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      return {
        name: path.basename(entry) || "workspace",
        path: path.resolve(entry)
      };
    }
    return {
      name: entry.slice(0, separator).trim(),
      path: path.resolve(entry.slice(separator + 1).trim())
    };
  }).filter((workspace) => workspace.name && workspace.path);

  if (entries.length > 0) {
    return entries;
  }

  return [
    {
      name: "default",
      path: defaultWorkspacePath
    }
  ];
}

function parseCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function uniqueIds(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readReasoningEffort(value: string): ProviderReasoningEffort | "adaptive" {
  const normalized = value.trim().toLowerCase();
  return normalized === "none" || normalized === "low" || normalized === "medium" || normalized === "high" || normalized === "xhigh" || normalized === "adaptive"
    ? normalized
    : "medium";
}

function defaultModelForProvider(provider: ModelProvider): string {
  if (provider === "gemini") {
    return defaultGeminiModel;
  }
  if (provider === "gemini-wrapper") {
    return defaultGeminiWrapperModel;
  }
  if (provider === "openrouter") {
    return defaultOpenRouterModel;
  }
  if (provider === "nvidia") {
    return defaultNvidiaModel;
  }
  if (provider === "codex") {
    return defaultCodexModel;
  }
  return defaultOllamaModel;
}
