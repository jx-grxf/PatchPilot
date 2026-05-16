#!/usr/bin/env node
import path from "node:path";
import { readFileSync } from "node:fs";
import React from "react";
import { render } from "ink";
import { Command } from "commander";
import { defaultCodexModel } from "./core/codex.js";
import { loadPatchPilotEnv } from "./core/env.js";
import { defaultGeminiModel } from "./core/gemini.js";
import { normalizeModelProvider, readModelProvider } from "./core/modelClient.js";
import { defaultNvidiaModel } from "./core/nvidia.js";
import { runDoctor } from "./core/doctor.js";
import { defaultOllamaModel, resolveOllamaBaseUrl } from "./core/ollama.js";
import { defaultOpenRouterModel } from "./core/openrouter.js";
import { listIndexedSessions, listWorkspaceSessions, loadSessionSummary } from "./core/session.js";
import { App } from "./tui/App.js";

loadPatchPilotEnv();

const defaultOllamaUrl = resolveOllamaBaseUrl();
const defaultProvider = readModelProvider();
const defaultModel =
  process.env.PATCHPILOT_MODEL ??
  (defaultProvider === "gemini"
    ? defaultGeminiModel
    : defaultProvider === "openrouter"
      ? defaultOpenRouterModel
      : defaultProvider === "nvidia"
        ? defaultNvidiaModel
      : defaultProvider === "codex"
        ? defaultCodexModel
        : defaultOllamaModel);

const program = new Command();
program.enablePositionalOptions();

program
  .name("patchpilot")
  .description("Local-first coding agent TUI powered by Ollama and OpenAI-compatible providers.")
  .version(readPackageVersion());

program
  .command("doctor")
  .description("Check local PatchPilot requirements.")
  .option("--provider <name>", "Model provider: ollama, gemini, openrouter, nvidia, or codex.", defaultProvider)
  .option("--check-url <url>", "Ollama base URL to verify", defaultOllamaUrl)
  .option("--ollama-url <url>", "Alias for --check-url.")
  .option("--check-model <name>", "Model name to verify", defaultModel)
  .option("--model <name>", "Alias for --check-model.")
  .action(async (options: {
      provider: string;
      checkUrl: string;
      ollamaUrl?: string;
      checkModel: string;
      model?: string;
    }) => {
    const results = await runDoctor(normalizeModelProvider(options.provider), options.ollamaUrl ?? options.checkUrl, options.model ?? options.checkModel);
    for (const result of results) {
      const marker = result.ok ? "ok" : "fail";
      console.log(`${marker.padEnd(5)} ${result.name}: ${result.details}`);
    }

    process.exitCode = results.every((result) => result.ok) ? 0 : 1;
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
  .option("--provider <name>", "Model provider: ollama, gemini, openrouter, nvidia, or codex.", defaultProvider)
  .option("--model <name>", "Model name", defaultModel)
  .option("--ollama-url <url>", "Ollama base URL", defaultOllamaUrl)
  .option("--steps <count>", "Maximum agent steps", "8")
  .option("--thinking <mode>", "Thinking budget mode: fixed or adaptive.", process.env.PATCHPILOT_THINKING_MODE ?? "fixed")
  .option("--reasoning <effort>", "Provider reasoning effort: none, low, medium, high, xhigh, or adaptive.", process.env.PATCHPILOT_REASONING_EFFORT ?? "medium")
  .option("--apply", "Allow file writes inside the workspace.", false)
  .option("--allow-shell", "Allow shell commands inside the workspace.", false)
  .option("--no-subagents", "Disable planner and reviewer subagents for faster local runs.")
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
        allowWrite={Boolean(options.apply)}
        allowShell={Boolean(options.allowShell)}
        maxSteps={Number.isFinite(maxSteps) ? maxSteps : 8}
        thinkingMode={String(options.thinking) === "adaptive" ? "adaptive" : "fixed"}
        reasoningEffort={readReasoningEffort(String(options.reasoning))}
        subagents={options.subagents !== false}
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

function readPackageVersion(): string {
  try {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
