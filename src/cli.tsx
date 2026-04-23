#!/usr/bin/env node
import path from "node:path";
import React from "react";
import { render } from "ink";
import { Command } from "commander";
import { runDoctor } from "./core/doctor.js";
import { defaultOllamaModel, resolveOllamaBaseUrl } from "./core/ollama.js";
import { App } from "./tui/App.js";

const defaultOllamaUrl = resolveOllamaBaseUrl();

const program = new Command();

program
  .name("patchpilot")
  .description("Local-first coding agent TUI powered by Ollama.")
  .version("0.1.0");

program
  .command("doctor")
  .description("Check local PatchPilot requirements.")
  .option("--check-url <url>", "Ollama base URL to verify", defaultOllamaUrl)
  .option("--ollama-url <url>", "Alias for --check-url.")
  .option("--check-model <name>", "Ollama model name to verify", process.env.PATCHPILOT_MODEL ?? defaultOllamaModel)
  .option("--model <name>", "Alias for --check-model.")
  .action(async (options: { checkUrl: string; ollamaUrl?: string; checkModel: string; model?: string }) => {
    const results = await runDoctor(options.ollamaUrl ?? options.checkUrl, options.model ?? options.checkModel);
    for (const result of results) {
      const marker = result.ok ? "ok" : "fail";
      console.log(`${marker.padEnd(5)} ${result.name}: ${result.details}`);
    }

    process.exitCode = results.every((result) => result.ok) ? 0 : 1;
  });

program
  .argument("[task...]", "Task for the local coding agent.")
  .option("--workspace <path>", "Workspace root", process.cwd())
  .option("--model <name>", "Ollama model name", process.env.PATCHPILOT_MODEL ?? defaultOllamaModel)
  .option("--ollama-url <url>", "Ollama base URL", defaultOllamaUrl)
  .option("--steps <count>", "Maximum agent steps", "8")
  .option("--apply", "Allow file writes inside the workspace.", false)
  .option("--allow-shell", "Allow shell commands inside the workspace.", false)
  .option("--no-subagents", "Disable planner and reviewer subagents for faster local runs.")
  .action((taskParts: string[], options: Record<string, unknown>) => {
    const workspace = path.resolve(String(options.workspace));
    const maxSteps = Number.parseInt(String(options.steps), 10);

    render(
      <App
        initialTask={taskParts.join(" ").trim() || undefined}
        model={String(options.model)}
        ollamaUrl={String(options.ollamaUrl)}
        workspace={workspace}
        allowWrite={Boolean(options.apply)}
        allowShell={Boolean(options.allowShell)}
        maxSteps={Number.isFinite(maxSteps) ? maxSteps : 8}
        subagents={options.subagents !== false}
      />
    );
  });

await program.parseAsync(process.argv);
