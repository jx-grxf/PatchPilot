#!/usr/bin/env node
import path from "node:path";
import React from "react";
import { render } from "ink";
import { Command } from "commander";
import { defaultCodexModel } from "./core/codex.js";
import { loadPatchPilotEnv } from "./core/env.js";
import { defaultGeminiModel } from "./core/gemini.js";
import { readModelProvider } from "./core/modelClient.js";
import { runDoctor } from "./core/doctor.js";
import { defaultOllamaModel, resolveOllamaBaseUrl } from "./core/ollama.js";
import { defaultOpenRouterModel } from "./core/openrouter.js";
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
      : defaultProvider === "codex"
        ? defaultCodexModel
        : defaultOllamaModel);

const program = new Command();

program
  .name("patchpilot")
  .description("Local-first coding agent TUI powered by Ollama.")
  .version("0.1.0");

program
  .command("doctor")
  .description("Check local PatchPilot requirements.")
  .option("--provider <name>", "Model provider: ollama, gemini, openrouter, or codex.", defaultProvider)
  .option("--check-url <url>", "Ollama base URL to verify", defaultOllamaUrl)
  .option("--ollama-url <url>", "Alias for --check-url.")
  .option("--check-model <name>", "Model name to verify", defaultModel)
  .option("--model <name>", "Alias for --check-model.")
  .action(async (options: { provider: string; checkUrl: string; ollamaUrl?: string; checkModel: string; model?: string }) => {
    const results = await runDoctor(readModelProvider({ PATCHPILOT_PROVIDER: options.provider }), options.ollamaUrl ?? options.checkUrl, options.model ?? options.checkModel);
    for (const result of results) {
      const marker = result.ok ? "ok" : "fail";
      console.log(`${marker.padEnd(5)} ${result.name}: ${result.details}`);
    }

    process.exitCode = results.every((result) => result.ok) ? 0 : 1;
  });

program
  .argument("[task...]", "Task for the local coding agent.")
  .option("--workspace <path>", "Workspace root", process.cwd())
  .option("--provider <name>", "Model provider: ollama, gemini, openrouter, or codex.", defaultProvider)
  .option("--model <name>", "Model name", defaultModel)
  .option("--ollama-url <url>", "Ollama base URL", defaultOllamaUrl)
  .option("--steps <count>", "Maximum agent steps", "8")
  .option("--thinking <mode>", "Thinking budget mode: fixed or adaptive.", process.env.PATCHPILOT_THINKING_MODE ?? "fixed")
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
        subagents={options.subagents !== false}
      />
    );
  });

await program.parseAsync(process.argv);
