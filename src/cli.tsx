#!/usr/bin/env node
import path from "node:path";
import { readFileSync } from "node:fs";
import React from "react";
import { render } from "ink";
import { Command } from "commander";
import { defaultCodexModel } from "./core/codex.js";
import { cleanupPatchPilot, readCleanupTarget } from "./core/cleanup.js";
import { loadPatchPilotEnv, savePatchPilotEnvValues } from "./core/env.js";
import { defaultGeminiModel } from "./core/gemini.js";
import { defaultGeminiWrapperModel, importGeminiWrapperBrowserCookies } from "./core/geminiWrapper.js";
import { normalizeModelProvider, readModelProvider } from "./core/modelClient.js";
import { defaultNvidiaModel } from "./core/nvidia.js";
import { runDoctor } from "./core/doctor.js";
import { ensurePatchPilotInstructions } from "./core/projectInit.js";
import { defaultOllamaModel, resolveOllamaBaseUrl } from "./core/ollama.js";
import { defaultOpenRouterModel } from "./core/openrouter.js";
import { listIndexedSessions, listWorkspaceSessions, loadSessionSummary } from "./core/session.js";
import {
  followDiscordLogs,
  formatDiscordStatus,
  installDiscordLaunchAgent,
  readDiscordLaunchdStatus,
  readDiscordRuntimeStatus,
  readDiscordConfig,
  redactDiscordConfig,
  registerDiscordCommands,
  requireDiscordConfig,
  runDiscordDaemon,
  stopDiscordLaunchAgent,
  summarizeLaunchdStatus,
  uninstallDiscordLaunchAgent,
  validateDiscordConfig
} from "./discord/index.js";
import { App } from "./tui/App.js";

loadPatchPilotEnv();

const defaultOllamaUrl = resolveOllamaBaseUrl();
const defaultProvider = readModelProvider();
const defaultModel =
  process.env.PATCHPILOT_MODEL ??
  (defaultProvider === "gemini"
    ? defaultGeminiModel
    : defaultProvider === "gemini-wrapper"
      ? defaultGeminiWrapperModel
    : defaultProvider === "openrouter"
      ? defaultOpenRouterModel
      : defaultProvider === "nvidia"
        ? defaultNvidiaModel
      : defaultProvider === "codex"
        ? defaultCodexModel
        : defaultOllamaModel);

// Onboarding persists the chosen first-run agent mode; bypass implies the
// always-allow write/shell defaults so the next launch starts where the user
// left off. plan and build keep the per-action approval flow.
const defaultMode = process.env.PATCHPILOT_DEFAULT_MODE?.trim().toLowerCase();
const defaultBypass = defaultMode === "bypass";

const program = new Command();
program.enablePositionalOptions();

program
  .name("patchpilot")
  .description("Local-first coding agent TUI powered by Ollama and OpenAI-compatible providers.")
  .version(readPackageVersion());

program
  .command("init")
  .description("Create PATCHPILOT.md workspace instructions.")
  .option("--workspace <path>", "Workspace root", process.cwd())
  .action(async (options: { workspace: string }) => {
    const result = await ensurePatchPilotInstructions(path.resolve(options.workspace));
    console.log(`${result.created ? "created" : "exists"} ${result.path}`);
  });

program
  .command("cleanup")
  .description("Clean PatchPilot workspace cache, sessions, temp files, or all.")
  .argument("[target]", "cache, sessions, temp, or all", "cache")
  .option("--workspace <path>", "Workspace root", process.cwd())
  .action(async (target: string, options: { workspace: string }) => {
    const cleanupTarget = readCleanupTarget(target);
    if (!cleanupTarget) {
      console.error("Use one of: cache, sessions, temp, all");
      process.exitCode = 1;
      return;
    }

    const removed = await cleanupPatchPilot(path.resolve(options.workspace), cleanupTarget);
    console.log(`cleaned ${removed.join(", ") || cleanupTarget}`);
  });

program
  .command("doctor")
  .description("Check local PatchPilot requirements.")
  .option("--provider <name>", "Model provider: ollama, gemini, gemini-wrapper, openrouter, nvidia, or codex.", defaultProvider)
  .option("--check-url <url>", "Ollama base URL to verify", defaultOllamaUrl)
  .option("--ollama-url <url>", "Alias for --check-url.")
  .option("--check-model <name>", "Model name to verify", defaultModel)
  .option("--model <name>", "Alias for --check-model.")
  .option("--fix", "Apply safe doctor fixes, such as installing the managed Gemini-API bridge.", false)
  .action(async (options: {
      provider: string;
      checkUrl: string;
      ollamaUrl?: string;
      checkModel: string;
      model?: string;
      fix?: boolean;
    }) => {
    const results = await runDoctor(normalizeModelProvider(options.provider), options.ollamaUrl ?? options.checkUrl, options.model ?? options.checkModel, {
      fix: Boolean(options.fix)
    });
    for (const result of results) {
      const marker = result.ok ? "ok" : "fail";
      const action = result.action ? ` ${result.action}` : "";
      console.log(`${marker.padEnd(5)} ${result.name}${action}: ${result.details}`);
    }

    process.exitCode = results.every((result) => result.ok) ? 0 : 1;
  });

const geminiWrapperCommand = program
  .command("gemini-wrapper")
  .description("Manage the local Gemini-Wrapper Python bridge.");

geminiWrapperCommand
  .command("import-cookies")
  .description("Explicitly import Gemini Web cookies from a local supported browser.")
  .action(async () => {
    try {
      const result = await importGeminiWrapperBrowserCookies();
      process.env.PATCHPILOT_PROVIDER = "gemini-wrapper";
      process.env.PATCHPILOT_MODEL = defaultGeminiWrapperModel;
      process.env.PATCHPILOT_GEMINI_WRAPPER_MODE = "python";
      process.env.PATCHPILOT_GEMINI_WRAPPER_COOKIES_JSON = result.cookiesPath;
      savePatchPilotEnvValues({
        PATCHPILOT_PROVIDER: "gemini-wrapper",
        PATCHPILOT_MODEL: defaultGeminiWrapperModel,
        PATCHPILOT_GEMINI_WRAPPER_MODE: "python",
        PATCHPILOT_GEMINI_WRAPPER_COOKIES_JSON: result.cookiesPath
      });
      console.log(`imported ${result.cookieCount} Gemini browser cookies from ${result.source}`);
      console.log(`saved ${result.cookiesPath}`);
      console.log(`__Secure-1PSIDTS ${result.hasSecure1psidts ? "present" : "missing; bridge will try refresh fallback"}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

program
  .command("sessions")
  .description("List recent PatchPilot sessions.")
  .option("--workspace <path>", "Workspace root. Defaults to the current directory.")
  .action(async (options: { workspace?: string }) => {
    const sessions = options.workspace ? await listWorkspaceSessions(path.resolve(options.workspace)) : await listIndexedSessions();
    if (sessions.length === 0) {
      console.log("No PatchPilot sessions found.");
      return;
    }

    for (const session of sessions.slice(0, 20)) {
      console.log(`${session.sessionId}  ${session.updatedAt}  ${session.workspace}  ${session.lastTask ?? ""}`);
    }
  });

const discordCommand = program
  .command("discord")
  .description("Manage the experimental PatchPilot Discord bot integration.");

discordCommand
  .command("run")
  .description("Run the Discord bot in the foreground.")
  .action(async () => {
    await runDiscordDaemon(requireDiscordConfig());
  });

discordCommand
  .command("register")
  .description("Register Discord slash commands.")
  .option("--guild <id>", "Register only for this guild. Defaults to PATCHPILOT_DISCORD_GUILD_IDS, then global.")
  .option("--dry-run", "Print command JSON without registering.", false)
  .action(async (options: { guild?: string; dryRun?: boolean }) => {
    const config = options.dryRun ? readDiscordConfig() : requireDiscordConfig();
    console.log(await registerDiscordCommands(config, { guildId: options.guild, dryRun: Boolean(options.dryRun) }));
  });

discordCommand
  .command("status")
  .description("Show Discord config, runtime, and launchd status.")
  .action(async () => {
    const config = readDiscordConfig();
    for (const issue of validateDiscordConfig(config)) {
      console.log(`${issue.ok ? "ok" : "fail"} ${issue.name}: ${issue.details}`);
    }
    console.log(JSON.stringify(redactDiscordConfig(config), null, 2));
    const launchd = await readDiscordLaunchdStatus();
    console.log(`launchd: ${summarizeLaunchdStatus(launchd)}`);
    console.log(formatDiscordStatus(await readDiscordRuntimeStatus(config.stateDir), { launchd: summarizeLaunchdStatus(launchd) }));
  });

discordCommand
  .command("install-service")
  .description("Install and start the macOS LaunchAgent for the Discord bot.")
  .action(async () => {
    const plistPath = await installDiscordLaunchAgent(requireDiscordConfig());
    console.log(`Installed and started ${plistPath}`);
  });

discordCommand
  .command("start-service")
  .description("Alias for install-service; writes the plist and kickstarts launchd.")
  .action(async () => {
    const plistPath = await installDiscordLaunchAgent(requireDiscordConfig());
    console.log(`Started ${plistPath}`);
  });

discordCommand
  .command("stop-service")
  .description("Stop the Discord LaunchAgent for the current login session.")
  .action(async () => {
    await stopDiscordLaunchAgent();
    console.log("Stopped PatchPilot Discord LaunchAgent.");
  });

discordCommand
  .command("uninstall-service")
  .description("Stop and remove the Discord LaunchAgent plist.")
  .action(async () => {
    await uninstallDiscordLaunchAgent();
    console.log("Removed PatchPilot Discord LaunchAgent.");
  });

discordCommand
  .command("logs")
  .description("Follow Discord bot logs.")
  .action(async () => {
    await followDiscordLogs(readDiscordConfig());
  });

program
  .command("resume")
  .description("Show a previous PatchPilot session summary.")
  .argument("[session-id]", "Session id to inspect. Defaults to the latest workspace session.")
  .option("--workspace <path>", "Workspace root", process.cwd())
  .action(async (sessionId: string | undefined, options: { workspace: string }) => {
    const workspace = path.resolve(options.workspace);
    const latest = sessionId ? null : (await listWorkspaceSessions(workspace))[0] ?? null;
    const summary = sessionId ? await loadSessionSummary(workspace, sessionId) : latest;
    if (!summary) {
      console.log("No PatchPilot session found for this workspace.");
      process.exitCode = 1;
      return;
    }

    console.log(`session: ${summary.sessionId}`);
    console.log(`workspace: ${summary.workspace}`);
    console.log(`updated: ${summary.updatedAt}`);
    console.log(`model: ${summary.provider ?? "-"} ${summary.model ?? "-"}`);
    console.log(`last task: ${summary.lastTask ?? "-"}`);
  });

program
  .argument("[task...]", "Task for the local coding agent.")
  .option("--workspace <path>", "Workspace root", process.cwd())
  .option("--provider <name>", "Model provider: ollama, gemini, gemini-wrapper, openrouter, nvidia, or codex.", defaultProvider)
  .option("--model <name>", "Model name", defaultModel)
  .option("--ollama-url <url>", "Ollama base URL", defaultOllamaUrl)
  .option("--steps <count>", "Maximum agent steps", "8")
  .option("--thinking <mode>", "Thinking budget mode: fixed or adaptive.", process.env.PATCHPILOT_THINKING_MODE ?? "adaptive")
  .option("--reasoning <effort>", "Provider reasoning effort: none, low, medium, high, xhigh, or adaptive.", process.env.PATCHPILOT_REASONING_EFFORT ?? "medium")
  .option("--apply", "Allow file writes inside the workspace.", false)
  .option("--allow-shell", "Allow shell commands inside the workspace.", false)
  .option("--subagents", "Enable planner and reviewer subagents.", readBooleanEnv(process.env.PATCHPILOT_SUBAGENTS, false))
  .option("--no-subagents", "Disable planner and reviewer subagents for faster local runs.")
  .addHelpText(
    "after",
    [
      "",
      "Examples:",
      "  $ patchpilot",
      "  $ patchpilot \"summarize this repo and list the safest next fixes\"",
      "  $ patchpilot --provider codex --model gpt-5.5 --workspace .",
      "  $ patchpilot --provider gemini-wrapper --model auto",
      "",
      "First-run setup opens automatically. Reopen it anytime with /onboarding."
    ].join("\n")
  )
  .action((taskParts: string[], options: Record<string, unknown>) => {
    const workspace = path.resolve(String(options.workspace));
    const maxSteps = Number.parseInt(String(options.steps), 10);

    render(
      <App
        initialTask={taskParts.join(" ").trim() || undefined}
        provider={readModelProvider({ PATCHPILOT_PROVIDER: String(options.provider) })}
        model={String(options.model)}
        ollamaUrl={String(options.ollamaUrl)}
        workspace={workspace}
        packageVersion={readPackageVersion()}
        allowWrite={Boolean(options.apply)}
        allowShell={Boolean(options.allowShell)}
        maxSteps={Number.isFinite(maxSteps) ? maxSteps : 8}
        thinkingMode={String(options.thinking) === "adaptive" ? "adaptive" : "fixed"}
        reasoningEffort={readReasoningEffort(String(options.reasoning))}
        subagents={Boolean(options.subagents)}
      />
    );
  });

await program.parseAsync(process.argv);

function readReasoningEffort(value: string): "none" | "low" | "medium" | "high" | "xhigh" | "adaptive" {
  return value === "none" || value === "off" || value === "false"
    ? "none"
    : value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "adaptive"
      ? value
      : "medium";
}

function readBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function readPackageVersion(): string {
  try {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
