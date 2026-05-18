import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ModelChatOptions, ModelChatResult, ModelTelemetry } from "./types.js";
import { getPatchPilotConfigDir } from "./env.js";
import { fetchWithTimeout } from "./http.js";
import { attachTokenCost, estimateTokens } from "./tokenAccounting.js";

export const defaultGeminiWrapperModel = "auto";
export const geminiWebApiVersion = "2.0.0";
export const geminiWebApiInstallCommand = `PatchPilot managed install: python3 -m venv ~/.patchpilot/gemini-wrapper-venv && ~/.patchpilot/gemini-wrapper-venv/bin/python -m pip install gemini_webapi==${geminiWebApiVersion}`;

type GeminiWrapperModelsResponse = {
  data?: Array<{
    id?: string;
  }>;
  error?: {
    message?: string;
  };
};

type GeminiWrapperChatResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
      cache_write_tokens?: number;
    };
  };
  error?: {
    message?: string;
  };
};

type GeminiWrapperRuntimeOptions = {
  maxTokens: number;
  temperature: number;
  bridgeMinIntervalMs?: number;
  bridgeTimeoutMs?: number;
};

type GeminiWrapperMode = "auto" | "http" | "python";

type PythonBridgeInput = {
  command: "authCheck" | "chat" | "models";
  model: string;
  prompt?: string;
  cookiesJson?: string;
  secure1psid?: string;
  secure1psidts?: string;
  proxy?: string;
  timeoutSeconds?: number;
};

type PythonBridgeOutput = {
  content?: string;
  error?: string;
  models?: string[];
  accountStatus?: string;
  model?: string;
};

export class GeminiWrapperClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly runtimeOptions: GeminiWrapperRuntimeOptions;
  private readonly mode: GeminiWrapperMode;
  private readonly pythonCommand: string;
  private readonly cookiesJson: string;

  constructor(
    baseUrl = readGeminiWrapperBaseUrl(),
    apiKey = readGeminiWrapperApiKey(),
    runtimeOptions = readGeminiWrapperRuntimeOptions(),
    mode = readGeminiWrapperMode(),
    pythonCommand = readGeminiWrapperPythonCommand(),
    cookiesJson = readGeminiWrapperCookiesJson()
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.runtimeOptions = runtimeOptions;
    this.mode = mode;
    this.pythonCommand = pythonCommand;
    this.cookiesJson = cookiesJson;
  }

  async chat(options: ModelChatOptions): Promise<ModelChatResult> {
    if (this.usesPythonBridge()) {
      return await this.chatWithPythonBridge(options);
    }

    this.assertConfigured();
    const startedAt = Date.now();
    const response = await this.fetchGeminiWrapper("/chat/completions", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(cleanUndefined({
        model: normalizeGeminiWrapperModel(options.model),
        messages: options.messages,
        max_tokens: this.runtimeOptions.maxTokens,
        temperature: this.runtimeOptions.temperature,
        response_format: options.formatJson ? { type: "json_object" } : undefined
      })),
      signal: options.signal
    });
    const durationMs = Date.now() - startedAt;
    const payload = (await readJsonSafely(response)) as GeminiWrapperChatResponse;

    if (!response.ok || payload.error) {
      const reason = payload.error?.message ? ` ${payload.error.message}` : "";
      if (response.status === 401 || response.status === 403) {
        throw new Error("Gemini-Wrapper authentication failed. Check PATCHPILOT_GEMINI_WRAPPER_API_KEY.");
      }
      if (response.status === 429) {
        throw new Error(`Gemini-Wrapper rate limit hit for model "${options.model}".${reason}`);
      }
      throw new Error(`Gemini-Wrapper chat failed for model "${options.model}": HTTP ${response.status}.${reason}`);
    }

    const content = payload.choices?.[0]?.message?.content?.trim() ?? "";
    if (!content) {
      throw new Error("Gemini-Wrapper returned an empty response.");
    }

    return {
      content,
      telemetry: toTelemetry(payload, durationMs, options.model)
    };
  }

  async listModels(): Promise<string[]> {
    if (this.usesPythonBridge()) {
      await this.assertPythonBridgeReady();
      const result = await this.runPythonBridge({
        command: "models",
        model: defaultGeminiWrapperModel
      });
      if (result.error) {
        throw new Error(result.error);
      }

      const models = [
        ...new Set(
          (result.models ?? [])
            .map((model) => model.trim())
            .filter((model) => model && isLikelyGeminiWrapperChatModel(model))
        )
      ];
      return [defaultGeminiWrapperModel, ...models.filter((model) => model !== defaultGeminiWrapperModel)];
    }

    this.assertConfigured();
    const response = await this.fetchGeminiWrapper("/models", {
      headers: this.headers()
    });
    const payload = (await readJsonSafely(response)) as GeminiWrapperModelsResponse;
    if (!response.ok || payload.error) {
      const reason = payload.error?.message ? ` ${payload.error.message}` : "";
      throw new Error(`Gemini-Wrapper models failed with HTTP ${response.status}.${reason}`);
    }

    const models = [
      ...new Set(
        payload.data
          ?.map((model) => model.id?.trim())
          .filter((model): model is string => Boolean(model))
          .filter(isLikelyGeminiWrapperChatModel) ?? []
      )
    ].sort();
    return models.length > 0 ? models : [defaultGeminiWrapperModel];
  }

  async checkBridgeAuth(): Promise<void> {
    await this.assertPythonBridgeReady();
    const result = await this.runPythonBridge({
      command: "authCheck",
      model: defaultGeminiWrapperModel
    });
    if (result.error) {
      throw new Error(result.error);
    }
  }

  private async fetchGeminiWrapper(path: string, init?: RequestInit): Promise<Response> {
    try {
      return await fetchWithTimeout(`${this.baseUrl}${path}`, init, {
        timeoutMs: init?.method === "POST" ? 90_000 : 8000,
        retries: init?.method === "POST" ? 0 : 1,
        label: `Gemini-Wrapper ${path}`
      });
    } catch (error) {
      const suffix = error instanceof Error ? ` ${error.message}` : "";
      throw new Error(`Cannot reach Gemini-Wrapper API at ${this.baseUrl}.${suffix}`);
    }
  }

  private headers(): HeadersInit {
    return cleanUndefined({
      "Content-Type": "application/json",
      Authorization: this.apiKey ? `Bearer ${this.apiKey}` : undefined
    }) as HeadersInit;
  }

  private assertConfigured(): void {
    if (this.usesPythonBridge()) {
      return;
    }

    if (!this.baseUrl) {
      throw new Error(
        `Gemini-Wrapper requires either an explicit OpenAI-compatible wrapper URL or the installed Gemini-API Python wrapper. Set PATCHPILOT_GEMINI_WRAPPER_BASE_URL, or install the bridge with: ${geminiWebApiInstallCommand}`
      );
    }

    if (geminiWrapperRequiresApiKey(this.baseUrl) && !this.apiKey) {
      throw new Error(
        "Gemini-Wrapper remote URLs require an explicit API key. Set PATCHPILOT_GEMINI_WRAPPER_API_KEY or GEMINI_WRAPPER_API_KEY. PatchPilot does not collect browser cookies."
      );
    }
  }

  private usesPythonBridge(): boolean {
    return this.mode === "python" || (this.mode === "auto" && !this.baseUrl);
  }

  private async chatWithPythonBridge(options: ModelChatOptions): Promise<ModelChatResult> {
    await this.assertPythonBridgeReady();
    const startedAt = Date.now();
    const prompt = toBridgePrompt(options.messages, options.formatJson);
    const bridgeModel = normalizeGeminiWrapperBridgeModel(options.model);
    const result = await this.runPythonBridge(
      {
        command: "chat",
        model: bridgeModel,
        prompt
      },
      options.signal,
      getGeminiWrapperBridgeTimeoutMs(bridgeModel || defaultGeminiWrapperModel, this.runtimeOptions.bridgeTimeoutMs)
    );
    const durationMs = Date.now() - startedAt;
    const content = result.content?.trim() ?? "";
    if (!content) {
      throw new Error(result.error ? `Gemini-API bridge failed: ${result.error}` : "Gemini-API bridge returned an empty response.");
    }

    return {
      content,
      telemetry: toEstimatedTelemetry(prompt, content, durationMs, result.model ?? options.model)
    };
  }

  private async runPythonBridge(input: Pick<PythonBridgeInput, "command" | "model" | "prompt">, signal?: AbortSignal, timeoutMs = getGeminiWrapperBridgeTimeoutMs(input.model, this.runtimeOptions.bridgeTimeoutMs)): Promise<PythonBridgeOutput> {
    const result = await runThrottledGeminiWebApiBridge(
      this.pythonCommand,
      {
        ...input,
        cookiesJson: this.cookiesJson || undefined,
        secure1psid: readGeminiWrapperSecure1psid() || undefined,
        secure1psidts: readGeminiWrapperSecure1psidts() || undefined,
        proxy: process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy
      },
      signal,
      this.runtimeOptions.bridgeMinIntervalMs,
      timeoutMs
    );
    if (!isUnauthenticatedGeminiWebError(result.error)) {
      return result;
    }

    clearGeminiWrapperCookieCache();
    return await runThrottledGeminiWebApiBridge(
      this.pythonCommand,
      {
        ...input,
        cookiesJson: this.cookiesJson || undefined,
        secure1psid: readGeminiWrapperSecure1psid() || undefined,
        secure1psidts: readGeminiWrapperSecure1psidts() || undefined,
        proxy: process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy
      },
      signal,
      this.runtimeOptions.bridgeMinIntervalMs,
      timeoutMs
    );
  }

  private async assertPythonBridgeReady(): Promise<void> {
    if (!this.cookiesJson && !readGeminiWrapperSecure1psid()) {
      throw new Error(
        "Gemini-API bridge needs explicit auth. Set PATCHPILOT_GEMINI_WRAPPER_COOKIES_JSON to a JSON cookie file, or set GEMINI_SECURE_1PSID / GEMINI_SECURE_1PSIDTS. PatchPilot will not scan browser cookies."
      );
    }

    const installed = await isGeminiWebApiInstalled(this.pythonCommand);
    if (!installed) {
      throw new Error(`Gemini-API Python wrapper is not installed for ${this.pythonCommand}. Run /doctor fix or patchpilot doctor --fix to install the pinned managed bridge. Manual fallback: ${geminiWebApiInstallCommand}`);
    }
  }
}

export function readGeminiWrapperMode(env: NodeJS.ProcessEnv = process.env): GeminiWrapperMode {
  const value = env.PATCHPILOT_GEMINI_WRAPPER_MODE?.trim().toLowerCase();
  return value === "http" || value === "python" || value === "auto" ? value : "auto";
}

export function readGeminiWrapperBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.PATCHPILOT_GEMINI_WRAPPER_BASE_URL?.trim() || "";
}

export function readGeminiWrapperApiKey(env: NodeJS.ProcessEnv = process.env): string {
  return env.PATCHPILOT_GEMINI_WRAPPER_API_KEY?.trim() || env.GEMINI_WRAPPER_API_KEY?.trim() || "";
}

export function readGeminiWrapperCookiesJson(env: NodeJS.ProcessEnv = process.env): string {
  return env.PATCHPILOT_GEMINI_WRAPPER_COOKIES_JSON?.trim() || env.GEMINI_COOKIES_JSON?.trim() || "";
}

export function getDefaultGeminiWrapperCookiesPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getPatchPilotConfigDir(env), "gemini-cookies.json");
}

export function saveGeminiWrapperCookieFile(
  values: {
    secure1psid: string;
    secure1psidts?: string;
  },
  env: NodeJS.ProcessEnv = process.env
): string {
  const secure1psid = values.secure1psid.trim();
  const secure1psidts = values.secure1psidts?.trim() ?? "";
  if (!secure1psid) {
    throw new Error("__Secure-1PSID cannot be empty.");
  }

  const configDir = getPatchPilotConfigDir(env);
  mkdirSync(configDir, {
    recursive: true,
    mode: 0o700
  });
  tryChmod(configDir, 0o700);

  const cookiesPath = getDefaultGeminiWrapperCookiesPath(env);
  writeFileSync(
    cookiesPath,
    `${JSON.stringify(
      {
        cookies: {
          "__Secure-1PSID": secure1psid,
          ...(secure1psidts ? { "__Secure-1PSIDTS": secure1psidts } : {})
        }
      },
      null,
      2
    )}\n`,
    {
      encoding: "utf8",
      mode: 0o600
    }
  );
  tryChmod(cookiesPath, 0o600);
  clearGeminiWrapperCookieCache(env);
  return cookiesPath;
}

export function readGeminiWrapperPythonCommand(env: NodeJS.ProcessEnv = process.env): string {
  return env.PATCHPILOT_GEMINI_WRAPPER_PYTHON?.trim() || getManagedGeminiWrapperPythonPath(env);
}

export function readGeminiWrapperBootstrapPythonCommand(env: NodeJS.ProcessEnv = process.env): string {
  return env.PATCHPILOT_GEMINI_WRAPPER_BOOTSTRAP_PYTHON?.trim() || "python3";
}

export function getGeminiWrapperVenvDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getPatchPilotConfigDir(env), "gemini-wrapper-venv");
}

export function getGeminiWrapperCookieCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getPatchPilotConfigDir(env), "gemini-webapi-cache");
}

export function clearGeminiWrapperCookieCache(env: NodeJS.ProcessEnv = process.env): void {
  const cacheDir = getGeminiWrapperCookieCacheDir(env);
  rmSync(cacheDir, {
    recursive: true,
    force: true
  });
  mkdirSync(cacheDir, {
    recursive: true,
    mode: 0o700
  });
  tryChmod(cacheDir, 0o700);
}

export function getManagedGeminiWrapperPythonPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getGeminiWrapperVenvDir(env), process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
}

export function readGeminiWrapperSecure1psid(env: NodeJS.ProcessEnv = process.env): string {
  return env.GEMINI_SECURE_1PSID?.trim() || "";
}

export function readGeminiWrapperSecure1psidts(env: NodeJS.ProcessEnv = process.env): string {
  return env.GEMINI_SECURE_1PSIDTS?.trim() || "";
}

export function geminiWrapperRequiresApiKey(baseUrl: string): boolean {
  return !isLocalWrapperUrl(baseUrl);
}

export async function isGeminiWebApiInstalled(pythonCommand = readGeminiWrapperPythonCommand()): Promise<boolean> {
  const result = await runQuietCommand(pythonCommand, ["-c", "import gemini_webapi"], 20_000);
  return result.ok;
}

export async function ensureGeminiWebApiInstalled(
  pythonCommand = readGeminiWrapperPythonCommand(),
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  if (await isGeminiWebApiInstalled(pythonCommand)) {
    return true;
  }

  const managedPython = getManagedGeminiWrapperPythonPath(env);
  if (path.resolve(pythonCommand) === path.resolve(managedPython)) {
    const venvDir = getGeminiWrapperVenvDir(env);
    mkdirSync(getPatchPilotConfigDir(env), {
      recursive: true,
      mode: 0o700
    });
    tryChmod(getPatchPilotConfigDir(env), 0o700);
    if (!existsSync(managedPython)) {
      const venvResult = await runQuietCommand(readGeminiWrapperBootstrapPythonCommand(env), ["-m", "venv", venvDir], 120_000);
      if (!venvResult.ok) {
        return false;
      }
    }
  }

  const installResult = await runQuietCommand(pythonCommand, ["-m", "pip", "install", `gemini_webapi==${geminiWebApiVersion}`], 180_000);
  return installResult.ok && (await isGeminiWebApiInstalled(pythonCommand));
}

function isLocalWrapperUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]";
  } catch {
    return false;
  }
}

function normalizeGeminiWrapperModel(model: string): string {
  const trimmedModel = model.trim();
  return trimmedModel || defaultGeminiWrapperModel;
}

function normalizeGeminiWrapperBridgeModel(model: string): string {
  const normalizedModel = normalizeGeminiWrapperModel(model).trim();
  return normalizedModel === defaultGeminiWrapperModel || normalizedModel === "gemini-web-default" ? "" : normalizedModel;
}

function isLikelyGeminiWrapperChatModel(model: string): boolean {
  const normalizedModel = model.toLowerCase();
  return !/(embedding|embed|imagen|veo|tts|audio|speech|rerank|rank|vision|bidi|live)/.test(normalizedModel);
}

function isUnauthenticatedGeminiWebError(error: string | undefined): boolean {
  return Boolean(error?.includes("Gemini web cookies are expired or unauthenticated"));
}

function readGeminiWrapperRuntimeOptions(env: NodeJS.ProcessEnv = process.env): GeminiWrapperRuntimeOptions {
  return {
    maxTokens: readPositiveInteger(env.PATCHPILOT_NUM_PREDICT, 1024),
    temperature: readTemperature(env.PATCHPILOT_TEMPERATURE, 0.1),
    bridgeMinIntervalMs: readNonNegativeInteger(env.PATCHPILOT_GEMINI_WRAPPER_MIN_INTERVAL_MS, 1500),
    bridgeTimeoutMs: readPositiveInteger(env.PATCHPILOT_GEMINI_WRAPPER_TIMEOUT_MS, 180_000)
  };
}

function toBridgePrompt(messages: ModelChatOptions["messages"], formatJson: boolean | undefined): string {
  const body = messages
    .map((message) => `${message.role.toUpperCase()}:\n${message.content}`)
    .join("\n\n");
  return formatJson ? `${body}\n\nReturn only valid JSON.` : body;
}

function toTelemetry(payload: GeminiWrapperChatResponse, durationMs: number, model: string): ModelTelemetry {
  const promptTokens = payload.usage?.prompt_tokens ?? 0;
  const responseTokens = payload.usage?.completion_tokens ?? 0;
  return attachTokenCost(
    {
      promptTokens,
      cachedPromptTokens: payload.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      cacheWriteTokens: payload.usage?.prompt_tokens_details?.cache_write_tokens ?? 0,
      responseTokens,
      totalTokens: payload.usage?.total_tokens ?? promptTokens + responseTokens,
      evalTokensPerSecond: responseTokens > 0 && durationMs > 0 ? responseTokens / (durationMs / 1000) : null,
      promptDurationMs: 0,
      responseDurationMs: durationMs,
      totalDurationMs: durationMs,
      tokenSource: "provider"
    },
    "gemini-wrapper",
    model
  );
}

function toEstimatedTelemetry(prompt: string, content: string, durationMs: number, model: string): ModelTelemetry {
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
    "gemini-wrapper",
    model
  );
}

let geminiBridgeQueue: Promise<unknown> = Promise.resolve();
let lastGeminiBridgeStartedAt = 0;

function getGeminiWrapperBridgeTimeoutMs(model: string, configuredTimeoutMs = readGeminiWrapperRuntimeOptions().bridgeTimeoutMs): number {
  const timeoutMs = configuredTimeoutMs ?? 180_000;
  return model.includes("pro") ? Math.max(timeoutMs, 240_000) : timeoutMs;
}

function runThrottledGeminiWebApiBridge(
  pythonCommand: string,
  input: PythonBridgeInput,
  signal: AbortSignal | undefined,
  minIntervalMs = readGeminiWrapperRuntimeOptions().bridgeMinIntervalMs,
  timeoutMs = getGeminiWrapperBridgeTimeoutMs(input.model)
): Promise<PythonBridgeOutput> {
  const run = async () => {
    const intervalMs = minIntervalMs ?? 0;
    const waitMs = Math.max(0, intervalMs - (Date.now() - lastGeminiBridgeStartedAt));
    if (waitMs > 0) {
      await sleep(waitMs, signal);
    }
    lastGeminiBridgeStartedAt = Date.now();
    return await runGeminiWebApiBridge(pythonCommand, input, timeoutMs, signal);
  };

  const result = geminiBridgeQueue.then(run, run);
  geminiBridgeQueue = result.catch(() => undefined);
  return result;
}

function runGeminiWebApiBridge(pythonCommand: string, input: PythonBridgeInput, timeoutMs: number, signal?: AbortSignal): Promise<PythonBridgeOutput> {
  return new Promise((resolve, reject) => {
    const cookieCacheDir = getGeminiWrapperCookieCacheDir();
    mkdirSync(cookieCacheDir, {
      recursive: true,
      mode: 0o700
    });
    tryChmod(cookieCacheDir, 0o700);

    const child = spawn(pythonCommand, ["-c", geminiWebApiBridgeScript], {
      env: {
        ...process.env,
        GEMINI_COOKIE_PATH: cookieCacheDir
      },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true
    });
    let settled = false;
    let pendingKillError: Error | null = null;
    let killTimer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      clearTimeout(timeout);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      signal?.removeEventListener("abort", abort);
    };
    const settleReject = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const settleResolve = (output: PythonBridgeOutput) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(output);
    };
    const killChild = (signalName: NodeJS.Signals): void => {
      if (child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, signalName);
          return;
        } catch {
          // Fall through to killing the child directly.
        }
      }
      child.kill(signalName);
    };
    const terminateChild = (error: Error) => {
      if (settled || pendingKillError) {
        return;
      }
      pendingKillError = error;
      killChild("SIGTERM");
      killTimer = setTimeout(() => {
        killChild("SIGKILL");
      }, 1500);
    };
    const abort = () => {
      terminateChild(new Error("Gemini-API bridge request aborted."));
    };
    signal?.addEventListener("abort", abort, {
      once: true
    });

    const timeout = setTimeout(() => {
      terminateChild(new Error(`Gemini-API bridge timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      settleReject(error);
    });
    child.on("close", (exitCode) => {
      if (pendingKillError) {
        settleReject(pendingKillError);
        return;
      }

      if (exitCode !== 0) {
        settleReject(new Error(stderr.trim() || `Gemini-API bridge exited with ${exitCode}.`));
        return;
      }

      try {
        settleResolve(JSON.parse(stdout) as PythonBridgeOutput);
      } catch {
        settleReject(new Error(`Gemini-API bridge returned invalid JSON.${stderr.trim() ? ` ${stderr.trim()}` : ""}`));
      }
    });
    child.stdin.end(JSON.stringify({
      ...input,
      timeoutSeconds: Math.max(30, Math.min(300, Math.floor(timeoutMs / 1000)))
    }));
  });
}

const geminiWebApiBridgeScript = String.raw`
import asyncio
import json
import os
import sys

async def main():
    from gemini_webapi import GeminiClient

    payload = json.load(sys.stdin)
    cookies = {}
    cookies_path = payload.get("cookiesJson")
    if cookies_path:
        with open(cookies_path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        if isinstance(data, dict) and isinstance(data.get("cookies"), dict):
            cookies.update(data["cookies"])
        elif isinstance(data, dict) and isinstance(data.get("cookies"), list):
            cookies.update({item.get("name"): item.get("value") for item in data["cookies"] if item.get("name") and item.get("value")})
        elif isinstance(data, list):
            cookies.update({item.get("name"): item.get("value") for item in data if item.get("name") and item.get("value")})
        elif isinstance(data, dict):
            cookies.update({key: value for key, value in data.items() if isinstance(value, str)})

    psid = cookies.get("__Secure-1PSID") or payload.get("secure1psid") or os.getenv("GEMINI_SECURE_1PSID")
    psidts = cookies.get("__Secure-1PSIDTS") or payload.get("secure1psidts") or os.getenv("GEMINI_SECURE_1PSIDTS") or ""
    if not psid:
        print(json.dumps({"error": "Missing __Secure-1PSID. Set PATCHPILOT_GEMINI_WRAPPER_COOKIES_JSON or GEMINI_SECURE_1PSID."}))
        return

    extra = {key: value for key, value in cookies.items() if key not in {"__Secure-1PSID", "__Secure-1PSIDTS"}}
    attempt_timeout = max(30, int(payload.get("timeoutSeconds") or 60))

    def is_transient_network_error(message):
        lower = message.lower()
        return (
            "curl: (28)" in lower
            or "connection timed out" in lower
            or "operation timed out" in lower
            or "readtimeout" in lower
            or "timeouterror" in lower
            or "temporarily unavailable" in lower
        )

    def account_status_name(client):
        status = getattr(client, "account_status", None)
        return getattr(status, "name", str(status or ""))

    def expired_cookie_error():
        return "Gemini web cookies are expired or unauthenticated. Refresh ~/.patchpilot/gemini-cookies.json through Gemini-Wrapper onboarding."

    def clear_cookie_cache():
        cache_dir = os.getenv("GEMINI_COOKIE_PATH")
        if not cache_dir:
            return
        try:
            for filename in os.listdir(cache_dir):
                if filename.startswith(".cached_cookies_") and filename.endswith(".json"):
                    os.remove(os.path.join(cache_dir, filename))
        except OSError:
            pass

    async def generate_once(psidts_value):
        client = GeminiClient(secure_1psid=psid, secure_1psidts=psidts_value, cookies=extra or None, proxy=payload.get("proxy"))
        await client.init(timeout=90, auto_refresh=False, verbose=False)
        try:
            status_name = account_status_name(client)
            if payload.get("command") == "authCheck":
                return {"content": "ok", "accountStatus": status_name}

            if payload.get("command") == "models":
                models = []
                for model in client.list_models() or []:
                    if not getattr(model, "is_available", True):
                        continue
                    name = getattr(model, "model_name", None) or getattr(model, "display_name", None)
                    if name:
                        models.append(name)
                return {"models": models, "accountStatus": status_name}

            request_model = payload.get("model") or ""
            request_kwargs = {"temporary": True}
            if request_model:
                request_kwargs["model"] = request_model
            response = await client.generate_content(payload.get("prompt") or "", **request_kwargs)
            text = getattr(response, "text", None) or str(response)
            return {"content": text, "accountStatus": status_name, "model": request_model or "auto"}
        finally:
            await client.close()

    async def generate_with_timestamp(psidts_value):
        last_error = None
        for attempt in range(3):
            try:
                return await asyncio.wait_for(generate_once(psidts_value), timeout=attempt_timeout)
            except asyncio.TimeoutError:
                if attempt >= 2:
                    raise TimeoutError(f"Gemini-API bridge attempt timed out after {attempt_timeout}s.")
                await asyncio.sleep(1.5 * (attempt + 1))
            except Exception as exc:
                last_error = exc
                if attempt >= 2 or not is_transient_network_error(str(exc)):
                    raise
                await asyncio.sleep(1.5 * (attempt + 1))
        raise last_error

    try:
        result = await generate_with_timestamp(psidts)
    except Exception as exc:
        message = str(exc)
        if psidts and ("__Secure-1PSIDTS" in message or "SECURE_1PSIDTS" in message):
            clear_cookie_cache()
            result = await generate_with_timestamp("")
        else:
            raise
    else:
        if psidts and isinstance(result, dict) and result.get("error") == expired_cookie_error():
            clear_cookie_cache()
            retry_result = await generate_with_timestamp("")
            if not retry_result.get("error"):
                retry_result["warning"] = "Retried without stale __Secure-1PSIDTS."
                print(json.dumps(retry_result))
                return
        print(json.dumps(result))
        return

    result["warning"] = "Retried without stale __Secure-1PSIDTS."
    print(json.dumps(result))

try:
    asyncio.run(main())
except Exception as exc:
    message = str(exc)
    if "currently unavailable or the request structure is outdated" in message:
        message = f"{message} Try /model auto and refresh Gemini-Wrapper cookies if this persists."
    print(json.dumps({"error": message}))
`;

function cleanUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

async function readJsonSafely(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsedValue = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : fallback;
}

function readNonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsedValue = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsedValue) && parsedValue >= 0 ? parsedValue : fallback;
}

function readTemperature(value: string | undefined, fallback: number): number {
  const parsedValue = Number.parseFloat(value ?? "");
  return Number.isFinite(parsedValue) && parsedValue >= 0 ? parsedValue : fallback;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Gemini-API bridge request aborted."));
      return;
    }

    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timeout);
      reject(new Error("Gemini-API bridge request aborted."));
    };
    signal?.addEventListener("abort", abort, {
      once: true
    });
  });
}

function tryChmod(filePath: string, mode: number): void {
  try {
    chmodSync(filePath, mode);
  } catch {
    // Best-effort hardening for platforms that do not support POSIX permissions.
  }
}

function runQuietCommand(command: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const timeout = setTimeout(() => {
      child.kill();
      resolve({
        ok: false,
        output: `${command} ${args.join(" ")} timed out.`
      });
    }, timeoutMs);
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({
        ok: false,
        output: error.message
      });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({
        ok: exitCode === 0,
        output: output.trim()
      });
    });
  });
}
