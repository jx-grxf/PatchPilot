import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { ModelChatOptions, ModelChatResult, ModelTelemetry } from "./types.js";

export const defaultCodexModel = "gpt-5.4";

export const codexOAuthModels = [
  "gpt-5.4",
  "gpt-5.2-codex",
  "gpt-5.1-codex-max",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.2",
  "gpt-5.1-codex-mini"
];

export class CodexCliClient {
  private readonly workspace: string;
  private readonly timeoutMs: number;

  constructor(options: { workspace: string; timeoutMs?: number }) {
    this.workspace = options.workspace;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async chat(options: ModelChatOptions): Promise<ModelChatResult> {
    const startedAt = Date.now();
    const tempRoot = await mkdtemp(path.join(tmpdir(), "patchpilot-codex-"));
    const outputPath = path.join(tempRoot, "last-message.txt");

    try {
      const prompt = buildCodexPrompt(options);
      await runCodexExec({
        model: options.model,
        workspace: this.workspace,
        prompt,
        outputPath,
        timeoutMs: this.timeoutMs
      });
      const content = (await readFile(outputPath, "utf8")).trim();
      if (!content) {
        throw new Error("Codex CLI returned an empty response.");
      }

      const durationMs = Date.now() - startedAt;
      return {
        content,
        telemetry: estimateTelemetry(prompt, content, durationMs)
      };
    } finally {
      await rm(tempRoot, {
        recursive: true,
        force: true
      });
    }
  }

  async listModels(): Promise<string[]> {
    return codexOAuthModels;
  }
}

export function hasCodexCliOAuth(codexAuthPath = defaultCodexAuthPath()): boolean {
  const auth = readCodexAuth(codexAuthPath);
  return Boolean(auth && isRecord(auth.tokens) && typeof auth.tokens.access_token === "string");
}

function buildCodexPrompt(options: ModelChatOptions): string {
  const modeInstruction = options.formatJson
    ? "Return exactly one JSON object and no Markdown. Do not wrap it in code fences."
    : "Return plain text.";
  const transcript = options.messages.map((message) => `${message.role.toUpperCase()}:\n${message.content}`).join("\n\n");

  return [
    "You are acting as PatchPilot's model backend.",
    "Do not edit files or run shell commands yourself.",
    "If repository context is needed, ask PatchPilot for tools by returning the required JSON tool_calls.",
    modeInstruction,
    "",
    transcript
  ].join("\n");
}

function runCodexExec(options: {
  model: string;
  workspace: string;
  prompt: string;
  outputPath: string;
  timeoutMs: number;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "codex",
      [
        "exec",
        "--model",
        options.model,
        "--sandbox",
        "read-only",
        "--cd",
        options.workspace,
        "--output-last-message",
        options.outputPath,
        "-"
      ],
      {
        cwd: options.workspace,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      }
    );

    let output = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Codex CLI timed out after ${options.timeoutMs}ms.`));
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`Cannot run Codex CLI. Install it and run codex login. ${error.message}`));
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      if (exitCode === 0) {
        resolve();
        return;
      }

      reject(new Error(`Codex CLI exited ${exitCode}. ${clip(output.trim(), 1200)}`));
    });

    child.stdin.end(options.prompt);
  });
}

function estimateTelemetry(prompt: string, content: string, durationMs: number): ModelTelemetry {
  const promptTokens = estimateTokens(prompt);
  const responseTokens = estimateTokens(content);

  return {
    promptTokens,
    responseTokens,
    totalTokens: promptTokens + responseTokens,
    evalTokensPerSecond: responseTokens > 0 && durationMs > 0 ? responseTokens / (durationMs / 1000) : null,
    promptDurationMs: 0,
    responseDurationMs: durationMs,
    totalDurationMs: durationMs
  };
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

function readCodexAuth(codexAuthPath: string): Record<string, unknown> | null {
  if (!existsSync(codexAuthPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(codexAuthPath, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function defaultCodexAuthPath(): string {
  return path.join(homedir(), ".codex", "auth.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function clip(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}...[clipped ${value.length - maxLength} chars]`;
}
