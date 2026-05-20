import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ModelChatOptions, ModelChatResult, ModelDescriptor, ModelFileAnalysisOptions, ModelTelemetry } from "./types.js";
import { getPatchPilotConfigDir } from "./env.js";
import { fetchWithTimeout } from "./http.js";
import { attachTokenCost, estimateTokens } from "./tokenAccounting.js";

export const defaultGeminiWrapperModel = "auto";
export const geminiWrapperShortcutModels = ["auto", "flash-lite", "flash", "pro"] as const;
export const geminiWrapperLegacyModels = ["thinking"] as const;
export const geminiWrapperCuratedModels = [...geminiWrapperShortcutModels, ...geminiWrapperLegacyModels] as const;
export const geminiWebApiVersion = "2.0.0";
export const geminiWebApiInstallCommand = `PatchPilot managed install: python3 -m venv ~/.patchpilot/gemini-wrapper-venv && ~/.patchpilot/gemini-wrapper-venv/bin/python -m pip install gemini_webapi==${geminiWebApiVersion} browser-cookie3`;
const pythonBridgeReadyTtlMs = 5 * 60_000;
const geminiBrowserCookieImportTimeoutMs = 60_000;
const geminiBridgeOutputMaxBytes = 2 * 1024 * 1024;
const geminiWrapperBrowserCookieNames = new Set([
  "__Secure-1PSID",
  "__Secure-1PSIDTS",
  "__Secure-1PSIDCC",
  "__Secure-1PAPISID",
  "__Secure-3PSID",
  "__Secure-3PSIDTS",
  "__Secure-3PSIDCC",
  "__Secure-3PAPISID",
  "__Secure-ENID",
  "AEC",
  "COMPASS",
  "GOOGLE_ABUSE_EXEMPTION",
  "NID",
  "SID",
  "HSID",
  "SSID",
  "APISID",
  "SAPISID"
]);

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
  files?: string[];
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
  modelDescriptors?: ModelDescriptor[];
  accountStatus?: string;
  model?: string;
  warning?: string;
};

export type GeminiWrapperBrowserCookie = {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number | null;
  source?: string;
};

export type GeminiWrapperBrowserCookieImportResult = {
  cookiesPath: string;
  cookieCount: number;
  source: string;
  availableSources: string[];
  hasSecure1psid: boolean;
  hasSecure1psidts: boolean;
};

type GeminiBrowserCookieImportOutput = {
  cookies?: GeminiWrapperBrowserCookie[];
  source?: string;
  availableSources?: string[];
  error?: string;
};

export class GeminiWrapperClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly runtimeOptions: GeminiWrapperRuntimeOptions;
  private readonly mode: GeminiWrapperMode;
  private readonly pythonCommand: string;
  private readonly cookiesJson: string;
  private modelDescriptorCache: { descriptors: ModelDescriptor[]; expiresAt: number } | null = null;
  private pythonBridgeReadyUntil = 0;
  private pythonBridgeReadyPromise: Promise<void> | null = null;

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
    const { payload, text } = await readGeminiWrapperResponse(response);

    if (!response.ok || payload.error) {
      const reason = formatGeminiWrapperErrorReason(payload, text, response);
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
    return (await this.listModelDescriptors()).map((model) => model.id);
  }

  async listModelDescriptors(): Promise<ModelDescriptor[]> {
    if (this.modelDescriptorCache && this.modelDescriptorCache.expiresAt > Date.now()) {
      return this.modelDescriptorCache.descriptors;
    }

    if (this.usesPythonBridge()) {
      await this.assertPythonBridgeReady();
      const result = await this.runPythonBridge({
        command: "models",
        model: defaultGeminiWrapperModel
      });
      if (result.error) {
        throw new Error(result.error);
      }

      const descriptors = normalizeGeminiWrapperModelDescriptors(result.modelDescriptors && result.modelDescriptors.length > 0 ? result.modelDescriptors : result.models ?? []);
      const mergedDescriptors = mergeGeminiWrapperModelDescriptors(descriptors);
      this.modelDescriptorCache = {
        descriptors: mergedDescriptors,
        expiresAt: Date.now() + 5 * 60_000
      };
      return mergedDescriptors;
    }

    this.assertConfigured();
    const response = await this.fetchGeminiWrapper("/models", {
      headers: this.headers()
    });
    const { payload, text } = await readGeminiWrapperResponse(response);
    if (!response.ok || payload.error) {
      const reason = formatGeminiWrapperErrorReason(payload, text, response);
      throw new Error(`Gemini-Wrapper models failed with HTTP ${response.status}.${reason}`);
    }

    const descriptors = normalizeGeminiWrapperModelDescriptors(
      payload.data
        ?.map((model) => model.id?.trim())
        .filter((model): model is string => Boolean(model))
        .filter(isLikelyGeminiWrapperChatModel) ?? []
    );
    const mergedDescriptors = mergeGeminiWrapperModelDescriptors(descriptors);
    this.modelDescriptorCache = {
      descriptors: mergedDescriptors,
      expiresAt: Date.now() + 5 * 60_000
    };
    return mergedDescriptors;
  }

  supportsFileAnalysis(): boolean {
    return this.usesPythonBridge();
  }

  async analyzeFile(options: ModelFileAnalysisOptions): Promise<ModelChatResult> {
    if (!this.usesPythonBridge()) {
      throw new Error("Gemini-Wrapper file analysis is only available through the managed Python Gemini-API bridge.");
    }

    await this.assertPythonBridgeReady();
    const startedAt = Date.now();
    const bridgeModel = await this.resolveGeminiWrapperBridgeModel(options.model);
    const result = await this.runPythonBridge(
      {
        command: "chat",
        model: bridgeModel,
        prompt: options.prompt,
        files: [options.path]
      },
      options.signal,
      getGeminiWrapperBridgeTimeoutMs(bridgeModel || defaultGeminiWrapperModel, this.runtimeOptions.bridgeTimeoutMs)
    );
    const durationMs = Date.now() - startedAt;
    const content = result.content?.trim() ?? "";
    if (!content) {
      throw new Error(result.error ? `Gemini-API bridge failed: ${result.error}` : "Gemini-API bridge returned an empty file analysis response.");
    }

    return {
      content,
      telemetry: toEstimatedTelemetry(`${options.prompt}\nFILE:${options.path}`, content, durationMs, result.model ?? options.model)
    };
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
    if (isUnauthenticatedGeminiWebStatus(result.accountStatus)) {
      throw new Error("Gemini-API bridge cookies are expired or unauthenticated. Refresh Gemini-Wrapper cookies.");
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
    const bridgeModel = await this.resolveGeminiWrapperBridgeModel(options.model);
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

  private async runPythonBridge(input: Pick<PythonBridgeInput, "command" | "model" | "prompt" | "files">, signal?: AbortSignal, timeoutMs = getGeminiWrapperBridgeTimeoutMs(input.model, this.runtimeOptions.bridgeTimeoutMs)): Promise<PythonBridgeOutput> {
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

  private async resolveGeminiWrapperBridgeModel(model: string): Promise<string> {
    const normalizedModel = normalizeGeminiWrapperModel(model).trim();
    if (normalizedModel === defaultGeminiWrapperModel || normalizedModel === "gemini-web-default") {
      return "";
    }

    if (!isGeminiWrapperShortcutModel(normalizedModel)) {
      return normalizedModel;
    }

    const descriptors = await this.getCachedModelDescriptors().catch(() => []);
    const descriptor = resolveGeminiWrapperShortcutDescriptor(normalizedModel, descriptors);
    if (descriptor) {
      return descriptor.id;
    }

    return normalizeGeminiWrapperBridgeModelFallback(normalizedModel);
  }

  private async getCachedModelDescriptors(): Promise<ModelDescriptor[]> {
    if (this.modelDescriptorCache && this.modelDescriptorCache.expiresAt > Date.now()) {
      return this.modelDescriptorCache.descriptors;
    }

    return await this.listModelDescriptors();
  }

  private async assertPythonBridgeReady(): Promise<void> {
    if (!this.cookiesJson && !readGeminiWrapperSecure1psid()) {
      throw new Error(
        "Gemini-API bridge needs explicit auth. Run `patchpilot gemini-wrapper import-cookies`, set PATCHPILOT_GEMINI_WRAPPER_COOKIES_JSON to a JSON cookie file, or set GEMINI_SECURE_1PSID / GEMINI_SECURE_1PSIDTS."
      );
    }

    if (this.pythonBridgeReadyUntil > Date.now()) {
      return;
    }

    if (!this.pythonBridgeReadyPromise) {
      this.pythonBridgeReadyPromise = this.checkPythonBridgeReady().finally(() => {
        this.pythonBridgeReadyPromise = null;
      });
    }

    await this.pythonBridgeReadyPromise;
  }

  private async checkPythonBridgeReady(): Promise<void> {
    const installed = await isGeminiWebApiInstalled(this.pythonCommand);
    if (!installed) {
      throw new Error(`Gemini-API Python wrapper is not installed for ${this.pythonCommand}. Run /doctor fix or patchpilot doctor --fix to install the pinned managed bridge. Manual fallback: ${geminiWebApiInstallCommand}`);
    }
    this.pythonBridgeReadyUntil = Date.now() + pythonBridgeReadyTtlMs;
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

export function saveGeminiWrapperCookieJarFile(
  cookies: GeminiWrapperBrowserCookie[],
  env: NodeJS.ProcessEnv = process.env
): string {
  const sanitizedCookies = sanitizeGeminiWrapperBrowserCookies(cookies);
  if (!sanitizedCookies.some((cookie) => cookie.name === "__Secure-1PSID")) {
    throw new Error("Imported Gemini browser cookies did not include __Secure-1PSID.");
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
        cookies: sanitizedCookies
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

export async function importGeminiWrapperBrowserCookies(options: {
  pythonCommand?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
} = {}): Promise<GeminiWrapperBrowserCookieImportResult> {
  const env = options.env ?? process.env;
  const pythonCommand = options.pythonCommand ?? readGeminiWrapperPythonCommand(env);
  const isInstalled = await ensureGeminiWebApiInstalled(pythonCommand, env);
  if (!isInstalled) {
    throw new Error(`Gemini browser cookie import needs the managed bridge. Run /doctor fix or install manually: ${geminiWebApiInstallCommand}`);
  }
  if (!(await isGeminiBrowserCookieImportInstalled(pythonCommand))) {
    throw new Error("Gemini browser cookie import needs the optional browser-cookie3 dependency. Run `patchpilot doctor --provider gemini-wrapper --fix`, then retry.");
  }

  const output = await runGeminiBrowserCookieImportBridge(
    pythonCommand,
    options.timeoutMs ?? geminiBrowserCookieImportTimeoutMs
  );
  if (output.error) {
    throw new Error(output.error);
  }

  const cookies = sanitizeGeminiWrapperBrowserCookies(output.cookies ?? []);
  const hasSecure1psid = cookies.some((cookie) => cookie.name === "__Secure-1PSID");
  const hasSecure1psidts = cookies.some((cookie) => cookie.name === "__Secure-1PSIDTS");
  if (!hasSecure1psid) {
    throw new Error("No __Secure-1PSID cookie was found in supported browsers. Sign in to Gemini in a supported browser, then retry the explicit import.");
  }

  const cookiesPath = saveGeminiWrapperCookieJarFile(cookies, env);
  return {
    cookiesPath,
    cookieCount: cookies.length,
    source: output.source ?? "browser",
    availableSources: output.availableSources ?? [],
    hasSecure1psid,
    hasSecure1psidts
  };
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

export async function isGeminiBrowserCookieImportInstalled(pythonCommand = readGeminiWrapperPythonCommand()): Promise<boolean> {
  const result = await runQuietCommand(pythonCommand, ["-c", "import gemini_webapi, browser_cookie3"], 20_000);
  return result.ok;
}

export async function ensureGeminiWebApiInstalled(
  pythonCommand = readGeminiWrapperPythonCommand(),
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  if ((await isGeminiWebApiInstalled(pythonCommand)) && (await isGeminiBrowserCookieImportInstalled(pythonCommand))) {
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

  const installResult = await runQuietCommand(pythonCommand, ["-m", "pip", "install", `gemini_webapi==${geminiWebApiVersion}`, "browser-cookie3"], 180_000);
  return installResult.ok && (await isGeminiBrowserCookieImportInstalled(pythonCommand));
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

function normalizeGeminiWrapperBridgeModelFallback(model: string): string {
  const normalizedModel = normalizeGeminiWrapperModel(model).trim();
  if (normalizedModel === defaultGeminiWrapperModel || normalizedModel === "gemini-web-default") {
    return "";
  }

  if (normalizedModel === "flash-lite") {
    return "flash-lite";
  }

  if (normalizedModel === "flash") {
    return "gemini-3-flash";
  }

  if (normalizedModel === "thinking") {
    return "gemini-3-flash-thinking";
  }

  if (normalizedModel === "pro") {
    return "gemini-3-pro";
  }

  return normalizedModel;
}

function normalizeGeminiWrapperModelDescriptors(models: Array<string | ModelDescriptor>): ModelDescriptor[] {
  return models
    .map((model) => (typeof model === "string" ? descriptorFromModelId(model) : normalizeGeminiWrapperModelDescriptor(model)))
    .filter((model): model is ModelDescriptor => Boolean(model?.id && isLikelyGeminiWrapperChatModel(formatModelDescriptorSearchText(model))));
}

function normalizeGeminiWrapperModelDescriptor(model: ModelDescriptor): ModelDescriptor | null {
  const id = String(model.id || model.modelName || model.displayName || "").trim();
  if (!id) {
    return null;
  }

  return cleanUndefined({
    id,
    modelName: model.modelName?.trim() || undefined,
    displayName: model.displayName?.trim() || undefined,
    description: model.description?.trim() || undefined,
    isAvailable: model.isAvailable,
    capacity: typeof model.capacity === "number" && Number.isFinite(model.capacity) ? model.capacity : undefined,
    capacityField: typeof model.capacityField === "number" && Number.isFinite(model.capacityField) ? model.capacityField : undefined,
    advancedOnly: model.advancedOnly,
    legacy: model.legacy
  }) as ModelDescriptor;
}

function descriptorFromModelId(model: string): ModelDescriptor {
  const id = model.trim();
  return {
    id,
    modelName: id,
    displayName: id
  };
}

function mergeGeminiWrapperModelDescriptors(models: ModelDescriptor[]): ModelDescriptor[] {
  const descriptors: ModelDescriptor[] = [
    {
      id: "auto",
      displayName: "Auto",
      description: "Let Gemini Web choose its current default model."
    },
    {
      id: "flash-lite",
      displayName: "Flash-Lite",
      description: "Shortcut resolved from live Gemini Web discovery."
    },
    {
      id: "flash",
      displayName: "Flash",
      description: "Shortcut resolved from live Gemini Web discovery, preferring Gemini 3.5 Flash when the bridge exposes it."
    },
    {
      id: "pro",
      displayName: "Pro",
      description: "Shortcut resolved from live Gemini Web discovery."
    },
    {
      id: "thinking",
      modelName: "gemini-3-flash-thinking",
      displayName: "Thinking legacy",
      description: "Legacy gemini_webapi shortcut; Gemini Web now exposes Denkaufwand instead of a recommended thinking model.",
      legacy: true
    }
  ];

  for (const model of models) {
    if (!hasGeminiWrapperDescriptor(descriptors, model)) {
      descriptors.push(model);
    }
  }

  return descriptors;
}

function hasGeminiWrapperDescriptor(descriptors: ModelDescriptor[], model: ModelDescriptor): boolean {
  const keys = descriptorKeys(model);
  return descriptors.some((descriptor) => descriptorKeys(descriptor).some((key) => keys.includes(key)));
}

function descriptorKeys(model: ModelDescriptor): string[] {
  return [model.id, model.modelName, model.displayName]
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => value.trim().toLowerCase());
}

function resolveGeminiWrapperShortcutDescriptor(shortcut: string, descriptors: ModelDescriptor[]): ModelDescriptor | null {
  const dynamicDescriptors = descriptors.filter((descriptor) => !geminiWrapperCuratedModels.includes(descriptor.id as typeof geminiWrapperCuratedModels[number]));
  const matches = (pattern: RegExp) => dynamicDescriptors.filter((descriptor) => pattern.test(formatModelDescriptorSearchText(descriptor)));

  if (shortcut === "flash-lite") {
    return matches(/flash[-\s]?lite/i)[0] ?? null;
  }

  if (shortcut === "flash") {
    return (
      matches(/3\.5.*flash/i).find((descriptor) => !/lite|thinking/i.test(formatModelDescriptorSearchText(descriptor))) ??
      matches(/\bflash\b/i).find((descriptor) => !/lite|thinking/i.test(formatModelDescriptorSearchText(descriptor))) ??
      null
    );
  }

  if (shortcut === "pro") {
    return matches(/\bpro\b/i)[0] ?? null;
  }

  if (shortcut === "thinking") {
    return matches(/thinking/i)[0] ?? null;
  }

  return null;
}

function isGeminiWrapperShortcutModel(model: string): boolean {
  return geminiWrapperCuratedModels.includes(model as typeof geminiWrapperCuratedModels[number]);
}

function formatModelDescriptorSearchText(model: ModelDescriptor): string {
  return [model.id, model.modelName, model.displayName, model.description].filter(Boolean).join(" ");
}

function isLikelyGeminiWrapperChatModel(model: string): boolean {
  const normalizedModel = model.toLowerCase();
  return !/(embedding|embed|imagen|veo|tts|audio|speech|rerank|rank|bidi|live)/.test(normalizedModel);
}

function isUnauthenticatedGeminiWebError(error: string | undefined): boolean {
  return Boolean(error?.includes("Gemini web cookies are expired or unauthenticated"));
}

function isUnauthenticatedGeminiWebStatus(status: string | undefined): boolean {
  return /unauth|expired|invalid/i.test(status ?? "");
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
      stdout = appendClipped(stdout, chunk.toString("utf8"), geminiBridgeOutputMaxBytes);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendClipped(stderr, chunk.toString("utf8"), geminiBridgeOutputMaxBytes);
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

function runGeminiBrowserCookieImportBridge(pythonCommand: string, timeoutMs: number): Promise<GeminiBrowserCookieImportOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonCommand, ["-c", geminiBrowserCookieImportScript], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      killChildProcess(child, "SIGTERM");
      reject(new Error("Gemini browser cookie import timed out."));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendClipped(stdout, chunk.toString("utf8"), geminiBridgeOutputMaxBytes);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendClipped(stderr, chunk.toString("utf8"), geminiBridgeOutputMaxBytes);
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`Gemini browser cookie import failed.${stderr.trim() ? ` ${redactCookieValues(stderr.trim())}` : ""}`));
        return;
      }

      try {
        resolve(JSON.parse(stdout.trim() || "{}") as GeminiBrowserCookieImportOutput);
      } catch {
        reject(new Error("Gemini browser cookie import did not return valid JSON."));
      }
    });
  });
}

function killChildProcess(child: ReturnType<typeof spawn>, signalName: NodeJS.Signals): void {
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signalName);
      return;
    } catch {
      // Fall through to killing the child directly.
    }
  }
  child.kill(signalName);
}

function sanitizeGeminiWrapperBrowserCookies(cookies: GeminiWrapperBrowserCookie[]): GeminiWrapperBrowserCookie[] {
  const byName = new Map<string, GeminiWrapperBrowserCookie>();
  for (const cookie of cookies) {
    if (!cookie || typeof cookie.name !== "string" || typeof cookie.value !== "string") {
      continue;
    }

    const name = cookie.name.trim();
    const value = cookie.value.trim();
    if (!name || !value || !geminiWrapperBrowserCookieNames.has(name)) {
      continue;
    }

    const domain = typeof cookie.domain === "string" ? cookie.domain.trim() : "";
    const normalizedDomain = domain.replace(/^\./, "").toLowerCase();
    if (normalizedDomain && normalizedDomain !== "google.com" && !normalizedDomain.endsWith(".google.com")) {
      continue;
    }

    const previousCookie = byName.get(name);
    const previousExpires = typeof previousCookie?.expires === "number" ? previousCookie.expires : 0;
    const nextExpires = typeof cookie.expires === "number" ? cookie.expires : 0;
    if (previousCookie && previousExpires > nextExpires) {
      continue;
    }

    byName.set(name, {
      name,
      value,
      ...(domain ? { domain } : {}),
      ...(typeof cookie.path === "string" && cookie.path ? { path: cookie.path } : {}),
      ...(typeof cookie.expires === "number" ? { expires: cookie.expires } : {}),
      ...(typeof cookie.source === "string" && cookie.source ? { source: cookie.source } : {})
    });
  }

  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function redactCookieValues(value: string): string {
  return value
    .replace(/(__Secure-[A-Za-z0-9_-]+)\s*=\s*([^\s,;]+)/g, "$1=<redacted>")
    .replace(/(PSID[A-Z]*)\s*[:=]\s*([^\s,;]+)/gi, "$1=<redacted>");
}

function appendClipped(currentValue: string, chunk: string, maxLength: number): string {
  const nextValue = currentValue + chunk;
  if (nextValue.length <= maxLength) {
    return nextValue;
  }

  const clippedMarker = `\n...[clipped ${nextValue.length - maxLength} chars]...\n`;
  return `${clippedMarker}${nextValue.slice(-maxLength + clippedMarker.length)}`;
}

const geminiBrowserCookieImportScript = String.raw`
import json

ALLOWED_COOKIE_NAMES = {
    "__Secure-1PSID",
    "__Secure-1PSIDTS",
    "__Secure-1PSIDCC",
    "__Secure-1PAPISID",
    "__Secure-3PSID",
    "__Secure-3PSIDTS",
    "__Secure-3PSIDCC",
    "__Secure-3PAPISID",
    "__Secure-ENID",
    "AEC",
    "COMPASS",
    "GOOGLE_ABUSE_EXEMPTION",
    "NID",
    "SID",
    "HSID",
    "SSID",
    "APISID",
    "SAPISID",
}

def normalize_domain(value):
    return (value or "").lstrip(".").lower()

def is_google_domain(value):
    domain = normalize_domain(value)
    return not domain or domain == "google.com" or domain.endswith(".google.com")

try:
    from gemini_webapi.utils.load_browser_cookies import load_browser_cookies

    browser_cookies = load_browser_cookies(domain_name="google.com", verbose=False)
    candidates = []
    available_sources = []
    for browser_name, cookies in browser_cookies.items():
        filtered = []
        for cookie in cookies or []:
            name = cookie.get("name")
            value = cookie.get("value")
            if name not in ALLOWED_COOKIE_NAMES or not value or not is_google_domain(cookie.get("domain")):
                continue
            filtered.append({
                "name": name,
                "value": value,
                "domain": cookie.get("domain") or ".google.com",
                "path": cookie.get("path") or "/",
                "expires": cookie.get("expires"),
                "source": browser_name,
            })
        if filtered:
            available_sources.append(browser_name)
            has_psid = any(cookie["name"] == "__Secure-1PSID" for cookie in filtered)
            has_psidts = any(cookie["name"] == "__Secure-1PSIDTS" for cookie in filtered)
            candidates.append({
                "browser": browser_name,
                "cookies": filtered,
                "score": (1 if has_psid else 0, 1 if has_psidts else 0, len(filtered), browser_name),
            })

    candidates.sort(key=lambda item: item["score"], reverse=True)
    if not candidates or not any(cookie["name"] == "__Secure-1PSID" for cookie in candidates[0]["cookies"]):
        print(json.dumps({
            "error": "No Gemini browser cookies were found in supported browsers. Sign in to Gemini in Chrome, Brave, Edge, Firefox, Safari, or another supported browser, then retry the explicit import.",
            "availableSources": available_sources,
        }))
    else:
        selected = candidates[0]
        print(json.dumps({
            "cookies": selected["cookies"],
            "source": selected["browser"],
            "availableSources": available_sources,
        }))
except Exception as exc:
    print(json.dumps({
        "error": f"Gemini browser cookie import failed: {type(exc).__name__}. Unlock the browser profile or macOS Keychain access, then retry."
    }))
`;

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
            or "curl: (56)" in lower
            or "connection timed out" in lower
            or "connection closed abruptly" in lower
            or "connection reset" in lower
            or "server returned nothing" in lower
            or "unexpected eof" in lower
            or "stream error" in lower
            or "http/2 stream" in lower
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
        await client.init(timeout=attempt_timeout, auto_refresh=True, verbose=False)
        try:
            status_name = account_status_name(client)
            if "unauth" in status_name.lower() or "expired" in status_name.lower() or "invalid" in status_name.lower():
                return {"error": expired_cookie_error(), "accountStatus": status_name}

            if payload.get("command") == "authCheck":
                return {"content": "ok", "accountStatus": status_name}

            if payload.get("command") == "models":
                models = []
                model_descriptors = []
                for model in client.list_models() or []:
                    if not getattr(model, "is_available", True):
                        continue
                    model_id = getattr(model, "model_id", None) or ""
                    name = getattr(model, "model_name", None) or ""
                    display_name = getattr(model, "display_name", None) or ""
                    description = getattr(model, "description", None) or ""
                    selection_id = model_id or name or display_name
                    if selection_id:
                        descriptor = {
                            "id": selection_id,
                            "modelName": name or None,
                            "displayName": display_name or name or selection_id,
                            "description": description or None,
                            "isAvailable": bool(getattr(model, "is_available", True)),
                            "advancedOnly": bool(getattr(model, "advanced_only", False)),
                        }
                        capacity = getattr(model, "capacity", None)
                        capacity_field = getattr(model, "capacity_field", None)
                        if isinstance(capacity, (int, float)):
                            descriptor["capacity"] = capacity
                        if isinstance(capacity_field, (int, float)):
                            descriptor["capacityField"] = capacity_field
                        model_descriptors.append({key: value for key, value in descriptor.items() if value is not None})
                    name = name or display_name or model_id
                    if name:
                        models.append(name)
                return {"models": models, "modelDescriptors": model_descriptors, "accountStatus": status_name}

            request_model = payload.get("model") or ""
            request_kwargs = {"temporary": True}
            if request_model:
                request_kwargs["model"] = request_model
            files = payload.get("files") or []
            if files:
                request_kwargs["files"] = files
            response = await client.generate_content(payload.get("prompt") or "", **request_kwargs)
            text = getattr(response, "text", None) or str(response)
            return {"content": text, "accountStatus": status_name, "model": request_model or "auto"}
        finally:
            await client.close()

    async def generate_with_timestamp(psidts_value):
        last_error = None
        max_attempts = 2 if payload.get("files") else 3
        for attempt in range(max_attempts):
            try:
                return await asyncio.wait_for(generate_once(psidts_value), timeout=attempt_timeout)
            except asyncio.TimeoutError:
                if attempt >= max_attempts - 1:
                    raise TimeoutError(f"Gemini-API bridge attempt timed out after {attempt_timeout}s.")
                await asyncio.sleep(1.5 * (attempt + 1))
            except Exception as exc:
                last_error = exc
                if attempt >= max_attempts - 1 or not is_transient_network_error(str(exc)):
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

async function readGeminiWrapperResponse(response: Response): Promise<{ payload: GeminiWrapperChatResponse & GeminiWrapperModelsResponse; text: string }> {
  const text = await response.text().catch(() => "");
  if (!text.trim()) {
    return {
      payload: {},
      text: ""
    };
  }

  try {
    return {
      payload: JSON.parse(text) as GeminiWrapperChatResponse & GeminiWrapperModelsResponse,
      text
    };
  } catch {
    return {
      payload: {},
      text
    };
  }
}

function formatGeminiWrapperErrorReason(payload: GeminiWrapperChatResponse & GeminiWrapperModelsResponse, text: string, response: Response): string {
  const retryAfter = response.headers.get("retry-after");
  const providerMessage = payload.error?.message?.trim() || text.replace(/\s+/g, " ").trim().slice(0, 300);
  const parts = [providerMessage, retryAfter ? `retry-after ${retryAfter}s` : ""].filter(Boolean);
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
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
