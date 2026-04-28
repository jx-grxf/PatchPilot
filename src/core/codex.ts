import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { ModelChatOptions, ModelChatResult, ModelTelemetry } from "./types.js";
import { attachTokenCost, estimateTokens } from "./tokenAccounting.js";

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
      const usage = await runCodexExec({
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
        telemetry: usage
          ? toTelemetryFromUsage(usage, durationMs, options.model)
          : estimateTelemetry(prompt, content, durationMs, options.model)
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
}): Promise<CodexUsage | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "codex",
      [
        "exec",
        "--json",
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

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Codex CLI timed out after ${options.timeoutMs}ms.`));
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`Cannot run Codex CLI. Install it and run codex login. ${error.message}`));
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      if (exitCode === 0) {
        resolve(parseCodexUsageFromJsonl(stdout));
        return;
      }

      const output = `${stdout}\n${stderr}`.trim();
      reject(new Error(`Codex CLI exited ${exitCode}. ${clip(output.trim(), 1200)}`));
    });

    child.stdin.end(options.prompt);
  });
}

type CodexUsage = {
  input_tokens: number;
  cached_input_tokens?: number;
  output_tokens: number;
};

export function parseCodexUsageFromJsonl(value: string): CodexUsage | null {
  let usage: CodexUsage | null = null;
  for (const line of value.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine.startsWith("{")) {
      continue;
    }

    const parsed = parseJsonObject(trimmedLine);
    if (!parsed || parsed.type !== "turn.completed" || !isRecord(parsed.usage)) {
      continue;
    }

    const inputTokens = readNonNegativeNumber(parsed.usage.input_tokens);
    const outputTokens = readNonNegativeNumber(parsed.usage.output_tokens);
    if (inputTokens === null || outputTokens === null) {
      continue;
    }

    usage = {
      input_tokens: inputTokens,
      cached_input_tokens: readNonNegativeNumber(parsed.usage.cached_input_tokens) ?? 0,
      output_tokens: outputTokens
    };
  }

  return usage;
}

function toTelemetryFromUsage(usage: CodexUsage, durationMs: number, model: string): ModelTelemetry {
  return attachTokenCost(
    {
      promptTokens: usage.input_tokens,
      cachedPromptTokens: usage.cached_input_tokens ?? 0,
      cacheWriteTokens: 0,
      responseTokens: usage.output_tokens,
      totalTokens: usage.input_tokens + usage.output_tokens,
      evalTokensPerSecond: usage.output_tokens > 0 && durationMs > 0 ? usage.output_tokens / (durationMs / 1000) : null,
      promptDurationMs: 0,
      responseDurationMs: durationMs,
      totalDurationMs: durationMs,
      tokenSource: "provider"
    },
    "codex",
    model
  );
}

function estimateTelemetry(prompt: string, content: string, durationMs: number, model: string): ModelTelemetry {
  const promptTokens = estimateTokens(prompt);
  const responseTokens = estimateTokens(content);

  return attachTokenCost(
    {
      promptTokens,
      cachedPromptTokens: 0,
      cacheWriteTokens: 0,
      responseTokens,
      totalTokens: promptTokens + responseTokens,
      evalTokensPerSecond: responseTokens > 0 && durationMs > 0 ? responseTokens / (durationMs / 1000) : null,
      promptDurationMs: 0,
      responseDurationMs: durationMs,
      totalDurationMs: durationMs,
      tokenSource: "estimated"
    },
    "codex",
    model
  );
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

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function clip(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}...[clipped ${value.length - maxLength} chars]`;
}
