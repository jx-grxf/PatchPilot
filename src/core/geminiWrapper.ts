import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ModelChatOptions, ModelChatResult, ModelTelemetry } from "./types.js";
import { getPatchPilotConfigDir } from "./env.js";
import { fetchWithTimeout } from "./http.js";
import { attachTokenCost, estimateTokens } from "./tokenAccounting.js";

export const defaultGeminiWrapperModel = "gemini-2.5-flash";
export const geminiWebApiInstallCommand = "python3 -m pip install -U gemini_webapi";

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
};

type GeminiWrapperMode = "auto" | "http" | "python";

type PythonBridgeInput = {
  command: "chat";
  model: string;
  prompt: string;
  cookiesJson?: string;
  secure1psid?: string;
  secure1psidts?: string;
  proxy?: string;
};

type PythonBridgeOutput = {
  content?: string;
  error?: string;
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
      return [
        "gemini-2.5-flash",
        "gemini-2.5-pro",
        "gemini-2.0-flash",
        "gemini-1.5-pro",
        "gemini-1.5-flash"
      ];
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
    const result = await runGeminiWebApiBridge(
      this.pythonCommand,
      {
        command: "chat",
        model: normalizeGeminiWrapperModel(options.model),
        prompt,
        cookiesJson: this.cookiesJson || undefined,
        secure1psid: readGeminiWrapperSecure1psid() || undefined,
        secure1psidts: readGeminiWrapperSecure1psidts() || undefined,
        proxy: process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy
      },
      options.signal
    );
    const durationMs = Date.now() - startedAt;
    const content = result.content?.trim() ?? "";
    if (!content) {
      throw new Error(result.error ? `Gemini-API bridge failed: ${result.error}` : "Gemini-API bridge returned an empty response.");
    }

    return {
      content,
      telemetry: toEstimatedTelemetry(prompt, content, durationMs, options.model)
    };
  }

  private async assertPythonBridgeReady(): Promise<void> {
    if (!this.cookiesJson && !readGeminiWrapperSecure1psid()) {
      throw new Error(
        "Gemini-API bridge needs explicit auth. Set PATCHPILOT_GEMINI_WRAPPER_COOKIES_JSON to a JSON cookie file, or set GEMINI_SECURE_1PSID / GEMINI_SECURE_1PSIDTS. PatchPilot will not scan browser cookies."
      );
    }

    const installed = await isGeminiWebApiInstalled(this.pythonCommand);
    if (!installed) {
      throw new Error(`Gemini-API Python wrapper is not installed for ${this.pythonCommand}. Run: ${geminiWebApiInstallCommand}`);
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
  return cookiesPath;
}

export function readGeminiWrapperPythonCommand(env: NodeJS.ProcessEnv = process.env): string {
  return env.PATCHPILOT_GEMINI_WRAPPER_PYTHON?.trim() || "python3";
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
  return await new Promise((resolve) => {
    const child = spawn(pythonCommand, ["-c", "import gemini_webapi"], {
      stdio: "ignore",
      windowsHide: true
    });
    child.on("error", () => resolve(false));
    child.on("close", (exitCode) => resolve(exitCode === 0));
  });
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

function isLikelyGeminiWrapperChatModel(model: string): boolean {
  const normalizedModel = model.toLowerCase();
  return !/(embedding|embed|imagen|veo|tts|audio|speech|rerank|rank|vision|bidi|live)/.test(normalizedModel);
}

function readGeminiWrapperRuntimeOptions(env: NodeJS.ProcessEnv = process.env): GeminiWrapperRuntimeOptions {
  return {
    maxTokens: readPositiveInteger(env.PATCHPILOT_NUM_PREDICT, 1024),
    temperature: readTemperature(env.PATCHPILOT_TEMPERATURE, 0.1)
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

function runGeminiWebApiBridge(pythonCommand: string, input: PythonBridgeInput, signal?: AbortSignal): Promise<PythonBridgeOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonCommand, ["-c", geminiWebApiBridgeScript], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    const abort = () => {
      child.kill();
      reject(new Error("Gemini-API bridge request aborted."));
    };
    signal?.addEventListener("abort", abort, {
      once: true
    });

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Gemini-API bridge timed out after 90s."));
    }, 90_000);

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (exitCode !== 0) {
        reject(new Error(stderr.trim() || `Gemini-API bridge exited with ${exitCode}.`));
        return;
      }

      try {
        resolve(JSON.parse(stdout) as PythonBridgeOutput);
      } catch {
        reject(new Error(`Gemini-API bridge returned invalid JSON.${stderr.trim() ? ` ${stderr.trim()}` : ""}`));
      }
    });
    child.stdin.end(JSON.stringify(input));
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
    client = GeminiClient(secure_1psid=psid, secure_1psidts=psidts, cookies=extra or None, proxy=payload.get("proxy"))
    await client.init(timeout=90, auto_refresh=False, verbose=False)
    try:
        response = await client.generate_content(payload["prompt"], model=payload.get("model") or "gemini-2.5-flash", temporary=True)
        text = getattr(response, "text", None) or str(response)
        print(json.dumps({"content": text}))
    finally:
        await client.close()

try:
    asyncio.run(main())
except Exception as exc:
    print(json.dumps({"error": str(exc)}))
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

function readTemperature(value: string | undefined, fallback: number): number {
  const parsedValue = Number.parseFloat(value ?? "");
  return Number.isFinite(parsedValue) && parsedValue >= 0 ? parsedValue : fallback;
}

function tryChmod(filePath: string, mode: number): void {
  try {
    chmodSync(filePath, mode);
  } catch {
    // Best-effort hardening for platforms that do not support POSIX permissions.
  }
}
