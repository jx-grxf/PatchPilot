import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type InteractionReplyOptions,
  type Message,
  type TextBasedChannel
} from "discord.js";
import type { ApprovalRequest, PermissionDecision } from "../core/types.js";
import { isDiscordSourceAllowed, resolveDiscordWorkspace, type PatchPilotDiscordConfig } from "./config.js";
import { registerDiscordCommands } from "./commands.js";
import { chunkDiscordMessage, formatApprovalRequest, formatDiscordEvent, formatDiscordRunSummary, parseApprovalDecision } from "./render.js";
import { runDiscordAgent, shouldRelayDiscordEvent, type DiscordAgentMode } from "./run.js";
import { listDiscordSessionRecords } from "./sessions.js";
import { formatDiscordStatus, readDiscordRuntimeStatus, writeDiscordRuntimeStatus } from "./status.js";

type PendingApproval = {
  request: ApprovalRequest;
  resolve: (decision: PermissionDecision) => void;
  userId: string;
  expiresAt: number;
};

const pendingApprovals = new Map<string, PendingApproval>();

export async function runDiscordDaemon(config: PatchPilotDiscordConfig): Promise<void> {
  if (!config.enabled) {
    throw new Error("Discord integration is disabled. Enable PATCHPILOT_EXPERIMENTAL_DISCORD=1 first.");
  }

  const client = new Client({
    intents: config.prefix ? [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent] : [GatewayIntentBits.Guilds]
  });

  client.once(Events.ClientReady, async (readyClient) => {
    await writeDiscordRuntimeStatus(config, {
      botUser: readyClient.user.tag,
      lastError: undefined
    });
    console.log(`PatchPilot Discord logged in as ${readyClient.user.tag}`);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isButton()) {
        await handleApprovalButton(interaction);
        return;
      }
      if (interaction.isChatInputCommand()) {
        await handleSlashCommand(config, interaction);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await writeDiscordRuntimeStatus(config, { lastError: message }).catch(() => undefined);
      console.error("Discord interaction failed:", error);
      await replyOrEdit(interaction as ChatInputCommandInteraction, {
        content: `PatchPilot failed: ${message}`,
        flags: MessageFlags.Ephemeral
      }).catch(() => undefined);
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    if (!config.prefix || message.author.bot) {
      return;
    }
    const content = message.content.trim();
    if (!content.startsWith(config.prefix)) {
      return;
    }
    try {
      await handlePrefixMessage(config, message);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await writeDiscordRuntimeStatus(config, { lastError: errorMessage }).catch(() => undefined);
      await message.reply(`PatchPilot failed: ${errorMessage}`).catch(() => undefined);
    }
  });

  const heartbeat = setInterval(() => {
    void writeDiscordRuntimeStatus(config, {
      botUser: client.user?.tag
    }).catch(() => undefined);
  }, 30_000);

  process.once("SIGTERM", () => {
    clearInterval(heartbeat);
    void client.destroy();
    process.exit(0);
  });
  process.once("SIGINT", () => {
    clearInterval(heartbeat);
    void client.destroy();
    process.exit(0);
  });

  await client.login(config.token);
}

async function handlePrefixMessage(config: PatchPilotDiscordConfig, message: Message): Promise<void> {
  if (!config.prefix) {
    return;
  }
  if (!isDiscordSourceAllowed(config, {
    guildId: message.guildId,
    channelId: message.channelId,
    userId: message.author.id
  })) {
    await message.reply("PatchPilot Discord is not enabled for this server/channel/user.");
    return;
  }
  const commandText = message.content.slice(config.prefix.length).trim();
  if (!commandText) {
    await message.reply("Use the prefix followed by a prompt, or run `/patchpilot ask`.");
    return;
  }
  if (commandText === "status") {
    await message.reply(codeBlock(formatDiscordStatus(await readDiscordRuntimeStatus(config.stateDir))));
    return;
  }
  const mode: DiscordAgentMode = commandText.startsWith("build ") ? "build" : commandText.startsWith("bypass ") ? "bypass" : "plan";
  const prompt = commandText.replace(/^(build|bypass|plan)\s+/i, "").trim();
  const workspace = config.defaultWorkspace;
  const started = await message.reply(`PatchPilot started in ${mode} mode for ${workspace.name}.`);
  const thread = message.channel.type === ChannelType.GuildText
    ? await started.startThread({
        name: `patchpilot-${prompt.replace(/\s+/g, "-").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 42) || "run"}`,
        autoArchiveDuration: 60
      }).catch(() => null)
    : null;
  const channel = thread ?? message.channel;
  const result = await runDiscordAgent({
    config,
    prompt,
    workspace: workspace.path,
    source: {
      guildId: message.guildId,
      channelId: message.channelId,
      threadId: thread?.id ?? (message.channel.isThread() ? message.channel.id : null),
      userId: message.author.id
    },
    mode,
    approvalHandler: async (request) => await requestDiscordApproval({
      request,
      channel,
      userId: message.author.id
    }),
    onEvent: async (event) => {
      if (!thread || !shouldRelayDiscordEvent(event)) {
        return;
      }
      const formatted = formatDiscordEvent(event);
      if (formatted && event.type !== "final") {
        await sendDiscordChunks(thread, formatted);
      }
    }
  });
  await started.edit(`PatchPilot finished session ${result.sessionId}.\n${formatDiscordRunSummary(result.counters)}`);
  await sendDiscordChunks(channel, result.finalMessage);
}

async function handleSlashCommand(config: PatchPilotDiscordConfig, interaction: ChatInputCommandInteraction): Promise<void> {
  if (interaction.commandName !== "patchpilot") {
    return;
  }

  if (!isDiscordSourceAllowed(config, {
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    userId: interaction.user.id
  })) {
    await interaction.reply({
      content: "PatchPilot Discord is not enabled for this server/channel/user.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "status") {
    const status = await readDiscordRuntimeStatus(config.stateDir);
    await interaction.reply({
      content: codeBlock(formatDiscordStatus(status)),
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (subcommand === "sessions") {
    const sessions = await listDiscordSessionRecords(config.stateDir);
    await interaction.reply({
      content: sessions.length > 0
        ? sessions.slice(0, 10).map((session, index) => `${index + 1}. ${session.sessionId} · ${session.scope} · ${session.workspace} · ${session.updatedAt}`).join("\n")
        : "No Discord PatchPilot sessions yet.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (subcommand === "usage") {
    const status = await readDiscordRuntimeStatus(config.stateDir);
    await interaction.reply({
      content: status?.lastRun ? `Last run: ${status.lastRun.summary ?? "no usage summary"}\nSession: ${status.lastRun.sessionId}` : "No completed Discord run yet.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (subcommand !== "ask") {
    return;
  }

  const prompt = interaction.options.getString("prompt", true).trim();
  const mode = readDiscordMode(interaction.options.getString("mode"));
  const workspace = resolveDiscordWorkspace(config, interaction.options.getString("workspace"));
  await interaction.deferReply();
  const thread = await ensureRunThread(interaction, prompt).catch(() => null);
  await interaction.editReply(`PatchPilot started in ${mode} mode for ${workspace.name}.`);

  const source = {
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    threadId: interaction.channel?.isThread() ? interaction.channel.id : thread?.id ?? null,
    userId: interaction.user.id
  };

  const result = await runDiscordAgent({
    config,
    prompt,
    workspace: workspace.path,
    source,
    mode,
    approvalHandler: async (request) => await requestDiscordApproval({
      request,
      channel: thread ?? interaction.channel,
      userId: interaction.user.id
    }),
    onEvent: async (event, counters) => {
      if (!thread || !shouldRelayDiscordEvent(event)) {
        return;
      }
      const formatted = formatDiscordEvent(event);
      if (!formatted) {
        return;
      }
      if (event.type === "final") {
        return;
      }
      await sendDiscordChunks(thread, formatted);
      if (event.type === "metrics") {
        await sendDiscordChunks(thread, formatDiscordRunSummary(counters));
      }
    }
  });

  await interaction.editReply(`PatchPilot finished session ${result.sessionId}.\n${formatDiscordRunSummary(result.counters)}`);
  await sendDiscordChunks(thread ?? interaction.channel, result.finalMessage);
}

async function requestDiscordApproval(params: {
  request: ApprovalRequest;
  channel: TextBasedChannel | null;
  userId: string;
}): Promise<PermissionDecision> {
  if (!params.channel || !("send" in params.channel)) {
    return "deny";
  }
  const customIdPrefix = `patchpilot-approval:${params.request.id}`;
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${customIdPrefix}:allow_once`).setLabel("Allow once").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${customIdPrefix}:allow_session`).setLabel("Allow session").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${customIdPrefix}:deny`).setLabel("Deny").setStyle(ButtonStyle.Danger)
  );
  await params.channel.send({
    content: formatApprovalRequest(params.request),
    components: [row]
  });
  return await new Promise<PermissionDecision>((resolve) => {
    const expiresAt = Date.now() + 120_000;
    pendingApprovals.set(params.request.id, {
      request: params.request,
      resolve,
      userId: params.userId,
      expiresAt
    });
    setTimeout(() => {
      const pending = pendingApprovals.get(params.request.id);
      if (!pending || pending.expiresAt !== expiresAt) {
        return;
      }
      pendingApprovals.delete(params.request.id);
      resolve("deny");
    }, 120_000).unref();
  });
}

async function handleApprovalButton(interaction: ButtonInteraction): Promise<void> {
  const match = interaction.customId.match(/^patchpilot-approval:([^:]+):/);
  const decision = parseApprovalDecision(interaction.customId);
  if (!match || !decision) {
    return;
  }
  const approvalId = match[1] ?? "";
  const pending = pendingApprovals.get(approvalId);
  if (!pending) {
    await interaction.reply({
      content: "That PatchPilot approval is no longer pending.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }
  if (pending.userId !== interaction.user.id) {
    await interaction.reply({
      content: "Only the user who started this PatchPilot run can answer this approval.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }
  pendingApprovals.delete(approvalId);
  pending.resolve(decision);
  await interaction.update({
    content: `${formatApprovalRequest(pending.request)}\n\nDecision: ${decision}`,
    components: []
  });
}

async function ensureRunThread(interaction: ChatInputCommandInteraction, prompt: string): Promise<TextBasedChannel | null> {
  const channel = interaction.channel;
  if (!channel || channel.type !== ChannelType.GuildText) {
    return channel;
  }
  const starter = await interaction.fetchReply();
  return await starter.startThread({
    name: `patchpilot-${prompt.replace(/\s+/g, "-").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 42) || "run"}`,
    autoArchiveDuration: 60
  });
}

async function sendDiscordChunks(channel: TextBasedChannel | null, text: string): Promise<void> {
  if (!channel || !("send" in channel)) {
    return;
  }
  for (const chunk of chunkDiscordMessage(text)) {
    await channel.send(chunk);
  }
}

async function replyOrEdit(interaction: ChatInputCommandInteraction, payload: InteractionReplyOptions): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({
      content: payload.content
    });
    return;
  }
  await interaction.reply(payload);
}

function readDiscordMode(value: string | null): DiscordAgentMode {
  return value === "build" || value === "bypass" ? value : "plan";
}

function codeBlock(value: string): string {
  return `\`\`\`\n${value.replaceAll("```", "'''")}\n\`\`\``;
}

export { registerDiscordCommands };
