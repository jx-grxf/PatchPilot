import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readDiscordConfig, redactSecret, validateDiscordConfig } from "../src/discord/config.js";
import { chunkDiscordMessage, parseApprovalDecision } from "../src/discord/render.js";
import { buildDiscordSessionKey, classifyDiscordSession, listDiscordSessionRecords, upsertDiscordSessionRecord } from "../src/discord/sessions.js";
import { formatDiscordStatus } from "../src/discord/status.js";

let tempRoot = "";

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), "patchpilot-discord-"));
});

afterEach(async () => {
  await rm(tempRoot, {
    recursive: true,
    force: true
  });
});

describe("Discord config", () => {
  it("parses allowlists, workspaces, and redacts secrets", () => {
    const config = readDiscordConfig({
      PATCHPILOT_CONFIG_DIR: path.join(tempRoot, "config"),
      PATCHPILOT_EXPERIMENTAL_DISCORD: "1",
      PATCHPILOT_DISCORD_TOKEN: "discord-token-secret",
      PATCHPILOT_DISCORD_CLIENT_ID: "123456789012345678",
      PATCHPILOT_DISCORD_GUILD_IDS: "1,2",
      PATCHPILOT_DISCORD_ALLOWED_CHANNEL_IDS: "3",
      PATCHPILOT_DISCORD_ADMIN_USER_IDS: "4,5",
      PATCHPILOT_DISCORD_WORKSPACES: `main=${tempRoot}`,
      PATCHPILOT_PROVIDER: "codex",
      PATCHPILOT_MODEL: "gpt-5.5"
    } as NodeJS.ProcessEnv);

    expect(config.enabled).toBe(true);
    expect(config.guildIds).toEqual(["1", "2"]);
    expect(config.allowedChannelIds).toEqual(["3"]);
    expect(config.adminUserIds).toEqual(["4", "5"]);
    expect(config.workspaces).toEqual([{ name: "main", path: tempRoot }]);
    expect(config.provider).toBe("codex");
    expect(redactSecret(config.token)).toBe("disc…cret");
    expect(validateDiscordConfig(config).every((issue) => issue.ok)).toBe(true);
  });

  it("reports missing required runtime config", () => {
    const config = readDiscordConfig({
      PATCHPILOT_CONFIG_DIR: path.join(tempRoot, "config")
    } as NodeJS.ProcessEnv);

    expect(validateDiscordConfig(config).filter((issue) => !issue.ok).map((issue) => issue.name)).toEqual(["experimental", "client", "token"]);
  });
});

describe("Discord sessions", () => {
  it("builds deterministic keys for dm, channel, and thread sources", () => {
    expect(buildDiscordSessionKey({ channelId: "dm-1", userId: "u1" })).toBe("discord:dm:u1");
    expect(buildDiscordSessionKey({ guildId: "g1", channelId: "c1", userId: "u1" })).toBe("discord:guild:g1:channel:c1:user:u1");
    expect(buildDiscordSessionKey({ guildId: "g1", channelId: "c1", threadId: "t1", userId: "u1" })).toBe("discord:guild:g1:thread:t1:user:u1");
    expect(classifyDiscordSession({ guildId: "g1", channelId: "c1", threadId: "t1", userId: "u1" })).toBe("guild-thread");
  });

  it("persists session records in PatchPilot config state", async () => {
    await upsertDiscordSessionRecord({
      stateDir: path.join(tempRoot, "state"),
      input: { guildId: "g1", channelId: "c1", userId: "u1" },
      sessionId: "session-1",
      workspace: tempRoot,
      prompt: "inspect repo"
    });

    await expect(listDiscordSessionRecords(path.join(tempRoot, "state"))).resolves.toEqual([
      expect.objectContaining({
        key: "discord:guild:g1:channel:c1:user:u1",
        sessionId: "session-1",
        lastPrompt: "inspect repo"
      })
    ]);
  });
});

describe("Discord rendering", () => {
  it("chunks long messages and parses approval decisions", () => {
    expect(chunkDiscordMessage("a".repeat(4100), 1000)).toHaveLength(5);
    expect(parseApprovalDecision("patchpilot-approval:id:allow_once")).toBe("allow_once");
    expect(parseApprovalDecision("patchpilot-approval:id:allow_session")).toBe("allow_session");
    expect(parseApprovalDecision("patchpilot-approval:id:deny")).toBe("deny");
  });

  it("formats missing and live status", () => {
    expect(formatDiscordStatus(null)).toContain("no runtime heartbeat");
    expect(formatDiscordStatus({
      enabled: true,
      pid: 123,
      updatedAt: "2026-05-23T10:00:00.000Z",
      guildCount: 1,
      allowedChannelCount: 2,
      adminUserCount: 1,
      activeSessions: 0,
      sessions: [],
      provider: "codex",
      model: "gpt-5.5",
      stateDir: tempRoot,
      logsDir: path.join(tempRoot, "logs")
    })).toContain("pid 123");
  });
});
