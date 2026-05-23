import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  PermissionFlagsBits,
  REST,
  Routes,
  type RESTPostAPIApplicationCommandsJSONBody
} from "discord.js";
import type { PatchPilotDiscordConfig } from "./config.js";

export const patchPilotDiscordCommands: RESTPostAPIApplicationCommandsJSONBody[] = [
  {
    name: "patchpilot",
    description: "Run PatchPilot from Discord.",
    type: ApplicationCommandType.ChatInput,
    default_member_permissions: PermissionFlagsBits.SendMessages.toString(),
    options: [
      {
        name: "ask",
        description: "Ask PatchPilot to work in a configured workspace.",
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            name: "prompt",
            description: "What PatchPilot should do.",
            type: ApplicationCommandOptionType.String,
            required: true
          },
          {
            name: "mode",
            description: "Execution mode. Plan is read-only; build asks for approvals.",
            type: ApplicationCommandOptionType.String,
            required: false,
            choices: [
              { name: "plan", value: "plan" },
              { name: "build", value: "build" },
              { name: "bypass", value: "bypass" }
            ]
          },
          {
            name: "workspace",
            description: "Configured workspace name.",
            type: ApplicationCommandOptionType.String,
            required: false
          }
        ]
      },
      {
        name: "status",
        description: "Show PatchPilot Discord daemon status.",
        type: ApplicationCommandOptionType.Subcommand
      },
      {
        name: "sessions",
        description: "List recent Discord-backed PatchPilot sessions.",
        type: ApplicationCommandOptionType.Subcommand
      },
      {
        name: "usage",
        description: "Show usage summary for the daemon.",
        type: ApplicationCommandOptionType.Subcommand
      }
    ]
  }
];

export async function registerDiscordCommands(config: PatchPilotDiscordConfig, options: { guildId?: string; dryRun?: boolean } = {}): Promise<string> {
  const guildIds = options.guildId ? [options.guildId] : config.guildIds;
  if (options.dryRun) {
    return JSON.stringify(patchPilotDiscordCommands, null, 2);
  }
  const rest = new REST({ version: "10" }).setToken(config.token);
  if (guildIds.length > 0) {
    for (const guildId of guildIds) {
      await rest.put(Routes.applicationGuildCommands(config.clientId, guildId), {
        body: patchPilotDiscordCommands
      });
    }
    return `Registered ${patchPilotDiscordCommands.length} PatchPilot command group for guild ${guildIds.join(", ")}.`;
  }
  await rest.put(Routes.applicationCommands(config.clientId), {
    body: patchPilotDiscordCommands
  });
  return "Registered global PatchPilot Discord commands. Discord can take up to one hour to show global command updates.";
}
