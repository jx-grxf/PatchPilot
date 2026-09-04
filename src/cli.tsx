#!/usr/bin/env node
import path from "node:path";
import { readFileSync } from "node:fs";
import React from "react";
import { render } from "ink";
import { Command } from "commander";
import { cleanupPatchPilot, readCleanupTarget } from "./core/cleanup.js";
import { loadPatchPilotEnv, savePatchPilotEnvValues } from "./core/env.js";
import { defaultLocalOpenAIModel, resolveLocalOpenAIBaseUrl } from "./core/localOpenAI.js";
import { describeModel, discoverModels, isUsableForChat, rankForAgentUse } from "./core/modelCatalog.js";
import { normalizeModelProvider, readModelProvider } from "./core/modelClient.js";
import { runDoctor } from "./core/doctor.js";
import { ensurePatchPilotInstructions } from "./core/projectInit.js";
import { defaultOllamaModel, resolveOllamaBaseUrl } from "./core/ollama.js";
import { listIndexedSessions, listWorkspaceSessions, loadSessionSummary } from "./core/session.js";
import { App } from "./tui/App.js";

loadPatchPilotEnv();

const defaultOllamaUrl = resolveOllamaBaseUrl();
const defaultProvider = readModelProvider();
const defaultLocalUrl = resolveLocalOpenAIBaseUrl();
const defaultModel =
  process.env.PATCHPILOT_MODEL ??
  (defaultProvider === "local-openai" ? defaultLocalOpenAIModel : defaultOllamaModel);

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
  .option("--provider <name>", "Model provider: ollama, or local-openai for any OpenAI-compatible local server (LM Studio, MLX, llama.cpp, vLLM).", defaultProvider)
  .option("--check-url <url>", "Ollama base URL to verify", defaultOllamaUrl)
  .option("--ollama-url <url>", "Alias for --check-url.")
  .option("--check-model <name>", "Model name to verify", defaultModel)
  .option("--model <name>", "Alias for --check-model.")
  .option("--local-url <url>", "Base URL of an OpenAI-compatible local server.", defaultLocalUrl)
  .action(async (options: {
      provider: string;
      checkUrl: string;
      ollamaUrl?: string;
      checkModel: string;
      model?: string;
      localUrl?: string;
    }) => {
    const results = await runDoctor(normalizeModelProvider(options.provider), options.ollamaUrl ?? options.checkUrl, options.model ?? options.checkModel, {
      localUrl: options.localUrl
    });
    for (const result of results) {
      const marker = result.ok ? "ok" : "fail";
      const action = result.action ? ` ${result.action}` : "";
      console.log(`${marker.padEnd(5)} ${result.name}${action}: ${result.details}`);
    }

    process.exitCode = results.every((result) => result.ok) ? 0 : 1;
  });

program
  .command("models")
  .description("List every model available across the local runtimes on this machine.")
  .option("--all", "Include models that cannot be used for chat.", false)
  .option("--json", "Emit machine-readable JSON.", false)
  .action(async (options: { all?: boolean; json?: boolean }) => {
    const catalog = await discoverModels();
    const models = rankForAgentUse(options.all ? catalog.models : catalog.models.filter(isUsableForChat));

    if (options.json) {
      console.log(JSON.stringify({ runtimes: catalog.runtimes.map((entry) => ({ id: entry.runtime.id, reachable: entry.reachable, detail: entry.detail })), models }, null, 2));
      return;
    }

    for (const status of catalog.runtimes) {
      const marker = status.reachable ? "up  " : "down";
      console.log(`${marker}  ${status.runtime.label.padEnd(11)} ${status.detail}`);
    }

    if (models.length === 0) {
      console.log("\nNo usable models found. Start one of the runtimes above, then run this again.");
      process.exitCode = 1;
      return;
    }

    console.log("");
    const width = Math.min(52, Math.max(...models.map((model) => model.id.length)));
    for (const model of models) {
      console.log(`  ${model.id.padEnd(width)}  ${describeModel(model)}`);
    }
    console.log(`\nUse one with: patchpilot --provider ${models[0]?.provider ?? "ollama"} --model ${models[0]?.id ?? ""}`);
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
  .option("--provider <name>", "Model provider: ollama, or local-openai for any OpenAI-compatible local server (LM Studio, MLX, llama.cpp, vLLM).", defaultProvider)
  .option("--model <name>", "Model name", defaultModel)
  .option("--ollama-url <url>", "Ollama base URL", defaultOllamaUrl)
  .option("--steps <count>", "Maximum agent steps", "8")
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
      "  $ patchpilot --provider local-openai --model qwen3-coder-30b --workspace .",
      "  $ patchpilot --provider ollama --model devstral:24b",
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
        subagents={Boolean(options.subagents)}
      />
    );
  });

await program.parseAsync(process.argv);

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
