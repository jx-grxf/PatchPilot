import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  disposeGeminiWrapperBridgeDaemon,
  GeminiWrapperClient,
  geminiWrapperRequiresApiKey,
  getDefaultGeminiWrapperCookiesPath,
  getGeminiWrapperCookieCacheDir,
  getGeminiWrapperVenvDir,
  getManagedGeminiWrapperPythonPath,
  importGeminiWrapperBrowserCookies,
  isGeminiBrowserCookieImportInstalled,
  geminiWrapperShortcutModels,
  normalizeGeminiWrapperBridgeModelFallback,
  readGeminiWrapperApiKey,
  readGeminiWrapperBaseUrl,
  readGeminiWrapperBootstrapPythonCommand,
  readGeminiWrapperCookiesJson,
  readGeminiWrapperMode,
  readGeminiWrapperPythonCommand,
  saveGeminiWrapperCookieFile,
  saveGeminiWrapperCookieJarFile
} from "../src/core/geminiWrapper.js";
import { normalizeModelProvider } from "../src/core/modelClient.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Gemini-Wrapper model routing", () => {
  // gemini_webapi 2.0.0 Model enum — the only model_name values the bridge
  // resolver accepts. Anything else raises ValueError inside generate_content.
  const validBridgeModels = new Set([
    "gemini-3-pro",
    "gemini-3-flash",
    "gemini-3-flash-thinking",
    "gemini-3-pro-plus",
    "gemini-3-flash-plus",
    "gemini-3-flash-thinking-plus",
    "gemini-3-pro-advanced",
    "gemini-3-flash-advanced",
    "gemini-3-flash-thinking-advanced",
  ]);

  it("offers the current Gemini Web shortcut tiers", () => {
    expect([...geminiWrapperShortcutModels]).toEqual(["auto", "flash-lite", "flash", "pro"]);
  });

  it("maps every shortcut fallback to a model the bridge can resolve", () => {
    // auto routes to the Gemini Web default — an empty model string.
    expect(normalizeGeminiWrapperBridgeModelFallback("auto")).toBe("");
    for (const shortcut of ["flash", "pro", "thinking"]) {
      const resolved = normalizeGeminiWrapperBridgeModelFallback(shortcut);
      expect(validBridgeModels.has(resolved), `${shortcut} -> ${resolved}`).toBe(true);
    }
  });

  it("routes each shortcut to a distinct model", () => {
    const flash = normalizeGeminiWrapperBridgeModelFallback("flash");
    const pro = normalizeGeminiWrapperBridgeModelFallback("pro");
    const thinking = normalizeGeminiWrapperBridgeModelFallback("thinking");
    expect(new Set([flash, pro, thinking]).size).toBe(3);
  });

  it("rescues a stray flash-lite onto the closest valid tier", () => {
    expect(normalizeGeminiWrapperBridgeModelFallback("flash-lite")).toBe("gemini-3-flash");
  });
});

describe("GeminiWrapperClient", () => {
  it("normalizes provider aliases and reads only explicit wrapper env values", () => {
    expect(normalizeModelProvider("gemini-wrapper")).toBe("gemini-wrapper");
    expect(normalizeModelProvider("geminiwrapper")).toBe("gemini-wrapper");
    expect(readGeminiWrapperBaseUrl({ PATCHPILOT_GEMINI_WRAPPER_BASE_URL: " http://localhost:8787/v1 " } as NodeJS.ProcessEnv)).toBe("http://localhost:8787/v1");
    expect(readGeminiWrapperApiKey({ PATCHPILOT_GEMINI_WRAPPER_API_KEY: " patch-key " } as NodeJS.ProcessEnv)).toBe("patch-key");
    expect(readGeminiWrapperApiKey({ GEMINI_WRAPPER_API_KEY: " wrapper-key " } as NodeJS.ProcessEnv)).toBe("wrapper-key");
    expect(readGeminiWrapperApiKey({ GEMINI_API_KEY: "official-gemini-key" } as NodeJS.ProcessEnv)).toBe("");
    expect(readGeminiWrapperMode({ PATCHPILOT_GEMINI_WRAPPER_MODE: "python" } as NodeJS.ProcessEnv)).toBe("python");
    expect(readGeminiWrapperMode({ PATCHPILOT_GEMINI_WRAPPER_MODE: "invalid" } as NodeJS.ProcessEnv)).toBe("auto");
    expect(readGeminiWrapperCookiesJson({ PATCHPILOT_GEMINI_WRAPPER_COOKIES_JSON: " /tmp/cookies.json " } as NodeJS.ProcessEnv)).toBe("/tmp/cookies.json");
    expect(readGeminiWrapperPythonCommand({ PATCHPILOT_GEMINI_WRAPPER_PYTHON: "python" } as NodeJS.ProcessEnv)).toBe("python");
    expect(readGeminiWrapperBootstrapPythonCommand({ PATCHPILOT_GEMINI_WRAPPER_BOOTSTRAP_PYTHON: "python3.12" } as NodeJS.ProcessEnv)).toBe("python3.12");
    expect(geminiWrapperRequiresApiKey("http://localhost:8787/v1")).toBe(false);
    expect(geminiWrapperRequiresApiKey("https://wrapper.example.com/v1")).toBe(true);
  });

  it("defaults Python bridge execution to PatchPilot's managed venv", () => {
    const configDir = path.join(tmpdir(), "patchpilot-test-config");
    const env = {
      PATCHPILOT_CONFIG_DIR: configDir
    } as NodeJS.ProcessEnv;
    // Build expected paths with path.join so the assertion uses the platform
    // separator (backslash on Windows, slash elsewhere).
    expect(getGeminiWrapperVenvDir(env)).toBe(path.join(configDir, "gemini-wrapper-venv"));
    expect(getGeminiWrapperCookieCacheDir(env)).toBe(path.join(configDir, "gemini-webapi-cache"));
    expect(readGeminiWrapperPythonCommand(env)).toBe(getManagedGeminiWrapperPythonPath(env));
  });

  it("only advertises file analysis for Python bridge mode", () => {
    expect(new GeminiWrapperClient("http://localhost:8787/v1", "", undefined, "http").supportsFileAnalysis()).toBe(false);
    expect(new GeminiWrapperClient("", "", undefined, "python", "python3", "").supportsFileAnalysis()).toBe(true);
  });

  it("writes pasted Gemini cookies into PatchPilot config with owner-only permissions", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "patchpilot-gemini-wrapper-"));
    try {
      const env = {
        PATCHPILOT_CONFIG_DIR: tempRoot
      } as NodeJS.ProcessEnv;
      const cookiesPath = saveGeminiWrapperCookieFile(
        {
          secure1psid: "psid-value",
          secure1psidts: "psidts-value"
        },
        env
      );

      expect(cookiesPath).toBe(getDefaultGeminiWrapperCookiesPath(env));
      await expect(readFile(cookiesPath, "utf8")).resolves.toContain("__Secure-1PSID");
      await expect(readFile(cookiesPath, "utf8")).resolves.toContain("psidts-value");
      expect((await stat(cookiesPath)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(tempRoot, {
        recursive: true,
        force: true
      });
    }
  });

  it("writes imported Gemini browser cookies without unrelated values", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "patchpilot-gemini-wrapper-"));
    try {
      const env = {
        PATCHPILOT_CONFIG_DIR: tempRoot
      } as NodeJS.ProcessEnv;
      const cookiesPath = saveGeminiWrapperCookieJarFile(
        [
          {
            name: "__Secure-1PSID",
            value: "psid-value",
            domain: ".google.com",
            path: "/",
            source: "chrome"
          },
          {
            name: "unrelated",
            value: "do-not-save",
            domain: ".google.com"
          }
        ],
        env
      );

      const content = await readFile(cookiesPath, "utf8");
      expect(cookiesPath).toBe(getDefaultGeminiWrapperCookiesPath(env));
      expect(content).toContain("__Secure-1PSID");
      expect(content).toContain("chrome");
      expect(content).not.toContain("do-not-save");
      expect((await stat(cookiesPath)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(tempRoot, {
        recursive: true,
        force: true
      });
    }
  });

  it("imports Gemini browser cookies through an explicit local bridge call", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "patchpilot-gemini-import-"));
    try {
      const pythonShimPath = path.join(tempRoot, "python-shim");
      await writeFile(
        pythonShimPath,
        [
          "#!/bin/sh",
          "case \"$2\" in",
          "  *load_browser_cookies*) printf '%s' '{\"cookies\":[{\"name\":\"__Secure-1PSID\",\"value\":\"psid-value\",\"domain\":\".google.com\",\"path\":\"/\",\"source\":\"chrome\"},{\"name\":\"__Secure-1PSIDTS\",\"value\":\"ts-value\",\"domain\":\".google.com\",\"path\":\"/\",\"source\":\"chrome\"}],\"source\":\"chrome\",\"availableSources\":[\"chrome\"]}' ;;",
          "  *) exit 0 ;;",
          "esac",
          ""
        ].join("\n"),
        "utf8"
      );
      await chmod(pythonShimPath, 0o755);

      const env = {
        PATCHPILOT_CONFIG_DIR: tempRoot
      } as NodeJS.ProcessEnv;
      const result = await importGeminiWrapperBrowserCookies({
        pythonCommand: pythonShimPath,
        env
      });
      const content = await readFile(result.cookiesPath, "utf8");

      expect(result).toMatchObject({
        cookieCount: 2,
        source: "chrome",
        hasSecure1psid: true,
        hasSecure1psidts: true
      });
      expect(content).toContain("__Secure-1PSIDTS");
      expect(content).toContain("ts-value");
    } finally {
      await rm(tempRoot, {
        recursive: true,
        force: true
      });
    }
  });

  it("redacts browser cookie values from import bridge failures", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "patchpilot-gemini-import-fail-"));
    try {
      const pythonShimPath = path.join(tempRoot, "python-shim");
      await writeFile(
        pythonShimPath,
        [
          "#!/bin/sh",
          "case \"$2\" in",
          "  *load_browser_cookies*) echo '__Secure-1PSID=secret-cookie-value PSIDTS: another-secret-value' >&2; exit 1 ;;",
          "  *) exit 0 ;;",
          "esac",
          ""
        ].join("\n"),
        "utf8"
      );
      await chmod(pythonShimPath, 0o755);

      await importGeminiWrapperBrowserCookies({
        pythonCommand: pythonShimPath,
        env: {
          PATCHPILOT_CONFIG_DIR: tempRoot
        } as NodeJS.ProcessEnv
      }).catch((error: unknown) => {
        expect(error).toBeInstanceOf(Error);
        const message = error instanceof Error ? error.message : String(error);
        expect(message).toContain("<redacted>");
        expect(message).not.toContain("secret-cookie-value");
        expect(message).not.toContain("another-secret-value");
      });
    } finally {
      await rm(tempRoot, {
        recursive: true,
        force: true
      });
    }
  });

  it("retries the Python bridge without a stale optional session timestamp", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "patchpilot-gemini-bridge-"));
    const originalConfigDir = process.env.PATCHPILOT_CONFIG_DIR;
    try {
      process.env.PATCHPILOT_CONFIG_DIR = tempRoot;
      const modulePath = path.join(tempRoot, "gemini_webapi.py");
      const pythonShimPath = path.join(tempRoot, "python-shim");
      const cookiesPath = path.join(tempRoot, "cookies.json");

      await writeFile(
        modulePath,
        [
          "class Response:",
          "    text = 'ok after timestamp retry'",
          "",
          "class GeminiClient:",
          "    def __init__(self, secure_1psid, secure_1psidts='', cookies=None, proxy=None):",
          "        self.secure_1psidts = secure_1psidts",
          "",
          "    async def init(self, timeout=90, auto_close=False, auto_refresh=False, verbose=False):",
          "        if self.secure_1psidts:",
          "            raise Exception('Failed to initialize client after 1 attempts. SECURE_1PSIDTS could get expired frequently')",
          "",
          "    async def generate_content(self, prompt, model='gemini-3-flash', temporary=True):",
          "        return Response()",
          "",
          "    async def close(self):",
          "        pass",
          ""
        ].join("\n"),
        "utf8"
      );
      await writeFile(
        pythonShimPath,
        `#!/bin/sh\nPYTHONPATH="${tempRoot}" python3 "$@"\n`,
        "utf8"
      );
      await chmod(pythonShimPath, 0o755);
      await writeFile(
        cookiesPath,
        JSON.stringify({
          cookies: {
            "__Secure-1PSID": "psid-value",
            "__Secure-1PSIDTS": "stale-ts"
          }
        }),
        "utf8"
      );

      const result = await new GeminiWrapperClient(
        "",
        "",
        {
          maxTokens: 256,
          temperature: 0.2,
          bridgeMinIntervalMs: 0
        },
        "python",
        pythonShimPath,
        cookiesPath
      ).chat({
        model: "gemini-3-flash",
        messages: [
          {
            role: "user",
            content: "hello"
          }
        ]
      });

      expect(result.content).toBe("ok after timestamp retry");
      expect((await stat(getGeminiWrapperCookieCacheDir())).mode & 0o777).toBe(0o700);
    } finally {
      if (originalConfigDir === undefined) {
        delete process.env.PATCHPILOT_CONFIG_DIR;
      } else {
        process.env.PATCHPILOT_CONFIG_DIR = originalConfigDir;
      }
      await rm(tempRoot, {
        recursive: true,
        force: true
      });
    }
  });

  it("retries transient curl 56 Gemini Web connection closures", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "patchpilot-gemini-curl56-"));
    const originalConfigDir = process.env.PATCHPILOT_CONFIG_DIR;
    try {
      process.env.PATCHPILOT_CONFIG_DIR = tempRoot;
      const modulePath = path.join(tempRoot, "gemini_webapi.py");
      const pythonShimPath = path.join(tempRoot, "python-shim");
      const cookiesPath = path.join(tempRoot, "cookies.json");
      const counterPath = path.join(tempRoot, "curl56-count.txt");

      await writeFile(
        modulePath,
        [
          "from pathlib import Path",
          "",
          `COUNTER = Path(${JSON.stringify(counterPath)})`,
          "",
          "class Response:",
          "    text = 'ok after curl 56 retry'",
          "",
          "class GeminiClient:",
          "    def __init__(self, secure_1psid, secure_1psidts='', cookies=None, proxy=None):",
          "        pass",
          "",
          "    async def init(self, timeout=90, auto_close=False, auto_refresh=True, verbose=False):",
          "        pass",
          "",
          "    async def generate_content(self, prompt, model='gemini-3-flash', temporary=True):",
          "        count = int(COUNTER.read_text() or '0') if COUNTER.exists() else 0",
          "        COUNTER.write_text(str(count + 1))",
          "        if count == 0:",
          "            raise Exception('Failed to perform, curl: (56) Connection closed abruptly. See https://curl.se/libcurl/c/libcurl-errors.html first for more details.')",
          "        return Response()",
          "",
          "    async def close(self):",
          "        pass",
          ""
        ].join("\n"),
        "utf8"
      );
      await writeFile(
        pythonShimPath,
        `#!/bin/sh\nPYTHONPATH="${tempRoot}" python3 "$@"\n`,
        "utf8"
      );
      await chmod(pythonShimPath, 0o755);
      await writeFile(
        cookiesPath,
        JSON.stringify({
          cookies: {
            "__Secure-1PSID": "psid-value"
          }
        }),
        "utf8"
      );

      const result = await new GeminiWrapperClient(
        "",
        "",
        {
          maxTokens: 256,
          temperature: 0.2,
          bridgeMinIntervalMs: 0
        },
        "python",
        pythonShimPath,
        cookiesPath
      ).chat({
        model: "gemini-3-flash",
        messages: [
          {
            role: "user",
            content: "hello"
          }
        ]
      });

      expect(result.content).toBe("ok after curl 56 retry");
      await expect(readFile(counterPath, "utf8")).resolves.toBe("2");
    } finally {
      if (originalConfigDir === undefined) {
        delete process.env.PATCHPILOT_CONFIG_DIR;
      } else {
        process.env.PATCHPILOT_CONFIG_DIR = originalConfigDir;
      }
      await rm(tempRoot, {
        recursive: true,
        force: true
      });
    }
  });

  it("lists Gemini Web models through the Python bridge instead of a static model list", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "patchpilot-gemini-models-"));
    const originalConfigDir = process.env.PATCHPILOT_CONFIG_DIR;
    try {
      process.env.PATCHPILOT_CONFIG_DIR = tempRoot;
      const modulePath = path.join(tempRoot, "gemini_webapi.py");
      const pythonShimPath = path.join(tempRoot, "python-shim");
      const cookiesPath = path.join(tempRoot, "cookies.json");

      await writeFile(
        modulePath,
        [
          "class Status:",
          "    name = 'AVAILABLE'",
          "",
          "class ModelItem:",
          "    def __init__(self, name, available=True, model_id=None, display_name=None, description=''):",
          "        self.model_id = model_id or name",
          "        self.model_name = name",
          "        self.display_name = display_name or name",
          "        self.description = description",
          "        self.capacity = 1",
          "        self.capacity_field = 12",
          "        self.is_available = available",
          "",
          "class GeminiClient:",
          "    def __init__(self, *args, **kwargs):",
          "        self.account_status = Status()",
          "",
          "    async def init(self, *args, **kwargs):",
          "        pass",
          "",
          "    def list_models(self):",
          "        return [ModelItem('', model_id='flash-lite-id', display_name='3.1 Flash-Lite', description='Schnellste Antworten'), ModelItem('gemini-2.5-flash'), ModelItem('gemini-2.0-flash-vision'), ModelItem('gemini-3-pro', False)]",
          "",
          "    async def close(self):",
          "        pass",
          ""
        ].join("\n"),
        "utf8"
      );
      await writeFile(pythonShimPath, `#!/bin/sh\nPYTHONPATH="${tempRoot}" python3 "$@"\n`, "utf8");
      await chmod(pythonShimPath, 0o755);
      await writeFile(cookiesPath, JSON.stringify({ cookies: { "__Secure-1PSID": "psid-value" } }), "utf8");

      const client = new GeminiWrapperClient("", "", { maxTokens: 256, temperature: 0.2, bridgeMinIntervalMs: 0 }, "python", pythonShimPath, cookiesPath);
      await expect(client.listModels()).resolves.toEqual(["auto", "flash-lite", "flash", "pro", "thinking", "flash-lite-id", "gemini-2.5-flash", "gemini-2.0-flash-vision"]);
      await expect(client.listModelDescriptors()).resolves.toContainEqual(
        expect.objectContaining({
          id: "flash-lite-id",
          displayName: "3.1 Flash-Lite",
          description: "Schnellste Antworten",
          capacity: 1,
          capacityField: 12
        })
      );
    } finally {
      if (originalConfigDir === undefined) {
        delete process.env.PATCHPILOT_CONFIG_DIR;
      } else {
        process.env.PATCHPILOT_CONFIG_DIR = originalConfigDir;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("retries without optional session timestamp when the bridge reports unauthenticated", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "patchpilot-gemini-unauth-ts-"));
    const originalConfigDir = process.env.PATCHPILOT_CONFIG_DIR;
    try {
      process.env.PATCHPILOT_CONFIG_DIR = tempRoot;
      const modulePath = path.join(tempRoot, "gemini_webapi.py");
      const pythonShimPath = path.join(tempRoot, "python-shim");
      const cookiesPath = path.join(tempRoot, "cookies.json");

      await writeFile(
        modulePath,
        [
          "class Status:",
          "    def __init__(self, name):",
          "        self.name = name",
          "",
          "class Response:",
          "    text = 'ok after unauthenticated timestamp retry'",
          "",
          "class GeminiClient:",
          "    def __init__(self, secure_1psid, secure_1psidts='', cookies=None, proxy=None):",
          "        self.account_status = Status('UNAUTHENTICATED' if secure_1psidts else 'AVAILABLE')",
          "",
          "    async def init(self, *args, **kwargs):",
          "        pass",
          "",
          "    async def generate_content(self, prompt, **kwargs):",
          "        return Response()",
          "",
          "    async def close(self):",
          "        pass",
          ""
        ].join("\n"),
        "utf8"
      );
      await writeFile(pythonShimPath, `#!/bin/sh\nPYTHONPATH="${tempRoot}" python3 "$@"\n`, "utf8");
      await chmod(pythonShimPath, 0o755);
      await writeFile(
        cookiesPath,
        JSON.stringify({
          cookies: {
            "__Secure-1PSID": "psid-value",
            "__Secure-1PSIDTS": "stale-ts"
          }
        }),
        "utf8"
      );

      const result = await new GeminiWrapperClient("", "", { maxTokens: 256, temperature: 0.2, bridgeMinIntervalMs: 0 }, "python", pythonShimPath, cookiesPath).chat({
        model: "auto",
        messages: [
          {
            role: "user",
            content: "hello"
          }
        ]
      });

      expect(result.content).toBe("ok after unauthenticated timestamp retry");
    } finally {
      if (originalConfigDir === undefined) {
        delete process.env.PATCHPILOT_CONFIG_DIR;
      } else {
        process.env.PATCHPILOT_CONFIG_DIR = originalConfigDir;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("uses the Gemini Web default model when Python bridge model is auto", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "patchpilot-gemini-auto-"));
    const originalConfigDir = process.env.PATCHPILOT_CONFIG_DIR;
    try {
      process.env.PATCHPILOT_CONFIG_DIR = tempRoot;
      const modulePath = path.join(tempRoot, "gemini_webapi.py");
      const pythonShimPath = path.join(tempRoot, "python-shim");
      const cookiesPath = path.join(tempRoot, "cookies.json");

      await writeFile(
        modulePath,
        [
          "class Status:",
          "    name = 'AVAILABLE'",
          "",
          "class Response:",
          "    text = 'ok with web default'",
          "",
          "class GeminiClient:",
          "    def __init__(self, *args, **kwargs):",
          "        self.account_status = Status()",
          "",
          "    async def init(self, *args, **kwargs):",
          "        pass",
          "",
          "    async def generate_content(self, prompt, **kwargs):",
          "        if 'model' in kwargs:",
          "            raise Exception('model should not be set for auto')",
          "        return Response()",
          "",
          "    async def close(self):",
          "        pass",
          ""
        ].join("\n"),
        "utf8"
      );
      await writeFile(pythonShimPath, `#!/bin/sh\nPYTHONPATH="${tempRoot}" python3 "$@"\n`, "utf8");
      await chmod(pythonShimPath, 0o755);
      await writeFile(cookiesPath, JSON.stringify({ cookies: { "__Secure-1PSID": "psid-value" } }), "utf8");

      const result = await new GeminiWrapperClient("", "", { maxTokens: 256, temperature: 0.2, bridgeMinIntervalMs: 0 }, "python", pythonShimPath, cookiesPath).chat({
        model: "auto",
        messages: [
          {
            role: "user",
            content: "hello"
          }
        ]
      });

      expect(result.content).toBe("ok with web default");
    } finally {
      if (originalConfigDir === undefined) {
        delete process.env.PATCHPILOT_CONFIG_DIR;
      } else {
        process.env.PATCHPILOT_CONFIG_DIR = originalConfigDir;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("maps curated Gemini-Wrapper models to Gemini Web model ids", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "patchpilot-gemini-curated-"));
    const originalConfigDir = process.env.PATCHPILOT_CONFIG_DIR;
    try {
      process.env.PATCHPILOT_CONFIG_DIR = tempRoot;
      const modulePath = path.join(tempRoot, "gemini_webapi.py");
      const pythonShimPath = path.join(tempRoot, "python-shim");
      const cookiesPath = path.join(tempRoot, "cookies.json");

      await writeFile(
        modulePath,
        [
          "import json",
          "class Status:",
          "    name = 'AVAILABLE'",
          "",
          "class Response:",
          "    def __init__(self, text):",
          "        self.text = text",
          "",
          "class ModelItem:",
          "    def __init__(self, model_id, name, display_name):",
          "        self.model_id = model_id",
          "        self.model_name = name",
          "        self.display_name = display_name",
          "        self.is_available = True",
          "",
          "class GeminiClient:",
          "    def __init__(self, *args, **kwargs):",
          "        self.account_status = Status()",
          "",
          "    async def init(self, *args, **kwargs):",
          "        pass",
          "",
          "    def list_models(self):",
          "        return [ModelItem('lite-id', '', '3.1 Flash-Lite'), ModelItem('flash35-id', 'gemini-3.5-flash', '3.5 Flash'), ModelItem('pro-id', 'gemini-3-pro', '3.1 Pro'), ModelItem('thinking-id', 'gemini-3-flash-thinking', 'Thinking legacy')]",
          "",
          "    async def generate_content(self, prompt, **kwargs):",
          "        return Response(json.dumps({'model': kwargs.get('model', '')}))",
          "",
          "    async def close(self):",
          "        pass",
          ""
        ].join("\n"),
        "utf8"
      );
      await writeFile(pythonShimPath, `#!/bin/sh\nPYTHONPATH="${tempRoot}" python3 "$@"\n`, "utf8");
      await chmod(pythonShimPath, 0o755);
      await writeFile(cookiesPath, JSON.stringify({ cookies: { "__Secure-1PSID": "psid-value" } }), "utf8");

      const client = new GeminiWrapperClient("", "", { maxTokens: 256, temperature: 0.2, bridgeMinIntervalMs: 0 }, "python", pythonShimPath, cookiesPath);
      await expect(client.chat({ model: "flash-lite", messages: [{ role: "user", content: "hello" }] })).resolves.toMatchObject({
        content: '{"model": "lite-id"}'
      });
      // Dynamic models advertise their human-readable model_name as the
      // selection id; the raw hex model_id is only a fallback.
      await expect(client.chat({ model: "flash", messages: [{ role: "user", content: "hello" }] })).resolves.toMatchObject({
        content: '{"model": "gemini-3.5-flash"}'
      });
      await expect(client.chat({ model: "thinking", messages: [{ role: "user", content: "hello" }] })).resolves.toMatchObject({
        content: '{"model": "gemini-3-flash-thinking"}'
      });
      await expect(client.chat({ model: "pro", messages: [{ role: "user", content: "hello" }] })).resolves.toMatchObject({
        content: '{"model": "gemini-3-pro"}'
      });
    } finally {
      if (originalConfigDir === undefined) {
        delete process.env.PATCHPILOT_CONFIG_DIR;
      } else {
        process.env.PATCHPILOT_CONFIG_DIR = originalConfigDir;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("passes file paths through the Python Gemini-API bridge", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "patchpilot-gemini-files-"));
    const originalConfigDir = process.env.PATCHPILOT_CONFIG_DIR;
    try {
      process.env.PATCHPILOT_CONFIG_DIR = tempRoot;
      const modulePath = path.join(tempRoot, "gemini_webapi.py");
      const pythonShimPath = path.join(tempRoot, "python-shim");
      const cookiesPath = path.join(tempRoot, "cookies.json");
      const imagePath = path.join(tempRoot, "sample.png");

      await writeFile(
        modulePath,
        [
          "import json",
          "class Status:",
          "    name = 'AVAILABLE'",
          "",
          "class Response:",
          "    def __init__(self, text):",
          "        self.text = text",
          "",
          "class GeminiClient:",
          "    def __init__(self, *args, **kwargs):",
          "        self.account_status = Status()",
          "",
          "    async def init(self, *args, **kwargs):",
          "        pass",
          "",
          "    async def generate_content(self, prompt, **kwargs):",
          "        return Response(json.dumps({'prompt': prompt, 'files': kwargs.get('files', []), 'model': kwargs.get('model', '')}))",
          "",
          "    async def close(self):",
          "        pass",
          ""
        ].join("\n"),
        "utf8"
      );
      await writeFile(pythonShimPath, `#!/bin/sh\nPYTHONPATH="${tempRoot}" python3 "$@"\n`, "utf8");
      await chmod(pythonShimPath, 0o755);
      await writeFile(cookiesPath, JSON.stringify({ cookies: { "__Secure-1PSID": "psid-value" } }), "utf8");
      await writeFile(imagePath, "fake image", "utf8");

      const client = new GeminiWrapperClient("", "", { maxTokens: 256, temperature: 0.2, bridgeMinIntervalMs: 0 }, "python", pythonShimPath, cookiesPath);
      const result = await client.analyzeFile({ model: "dynamic-model-id", path: imagePath, prompt: "Describe this" });
      expect(JSON.parse(result.content)).toEqual({ prompt: "Describe this", files: [imagePath], model: "dynamic-model-id" });
    } finally {
      if (originalConfigDir === undefined) {
        delete process.env.PATCHPILOT_CONFIG_DIR;
      } else {
        process.env.PATCHPILOT_CONFIG_DIR = originalConfigDir;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("requires explicit bridge auth unless browser cookies are explicitly imported", async () => {
    const client = new GeminiWrapperClient("", "");
    await expect(
      client.chat({
        model: "gemini-2.5-flash",
        messages: [
          {
            role: "user",
            content: "hello"
          }
        ]
      })
    ).rejects.toThrow("patchpilot gemini-wrapper import-cookies");
  });

  it("fails auth checks when the Python bridge reports an unauthenticated account", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "patchpilot-gemini-auth-status-"));
    const originalConfigDir = process.env.PATCHPILOT_CONFIG_DIR;
    try {
      process.env.PATCHPILOT_CONFIG_DIR = tempRoot;
      const modulePath = path.join(tempRoot, "gemini_webapi.py");
      const pythonShimPath = path.join(tempRoot, "python-shim");
      const cookiesPath = path.join(tempRoot, "cookies.json");

      await writeFile(
        modulePath,
        [
          "class Status:",
          "    name = 'UNAUTHENTICATED'",
          "",
          "class GeminiClient:",
          "    def __init__(self, *args, **kwargs):",
          "        self.account_status = Status()",
          "",
          "    async def init(self, *args, **kwargs):",
          "        pass",
          "",
          "    async def close(self):",
          "        pass",
          ""
        ].join("\n"),
        "utf8"
      );
      await writeFile(pythonShimPath, `#!/bin/sh\nPYTHONPATH="${tempRoot}" python3 "$@"\n`, "utf8");
      await chmod(pythonShimPath, 0o755);
      await writeFile(cookiesPath, JSON.stringify({ cookies: { "__Secure-1PSID": "psid-value" } }), "utf8");

      await expect(new GeminiWrapperClient("", "", { maxTokens: 256, temperature: 0.2, bridgeMinIntervalMs: 0 }, "python", pythonShimPath, cookiesPath).checkBridgeAuth()).rejects.toThrow("unauthenticated");
    } finally {
      if (originalConfigDir === undefined) {
        delete process.env.PATCHPILOT_CONFIG_DIR;
      } else {
        process.env.PATCHPILOT_CONFIG_DIR = originalConfigDir;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("requires an explicit API key for remote wrapper URLs", async () => {
    const client = new GeminiWrapperClient("https://wrapper.example.com/v1", "", undefined, "http");
    await expect(client.listModels()).rejects.toThrow("remote URLs require an explicit API key");
  });

  it("sends OpenAI-compatible chat requests with optional Authorization", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(1000).mockReturnValueOnce(1500);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "{\"action\":\"final\",\"message\":\"ok\"}"
              }
            }
          ],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 4,
            total_tokens: 16,
            prompt_tokens_details: {
              cached_tokens: 8,
              cache_write_tokens: 0
            }
          }
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        }
      )
    );

    const result = await new GeminiWrapperClient(
      "https://wrapper.example.com/v1",
      "test-key",
      {
        maxTokens: 256,
        temperature: 0.2
      },
      "http"
    ).chat({
      model: "gemini-2.5-flash",
      formatJson: true,
      messages: [
        {
          role: "user",
          content: "hello"
        }
      ]
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://wrapper.example.com/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-key"
        })
      })
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: "gemini-2.5-flash",
      max_tokens: 256,
      temperature: 0.2,
      response_format: {
        type: "json_object"
      }
    });
    expect(result.telemetry).toMatchObject({
      promptTokens: 12,
      cachedPromptTokens: 8,
      cacheWriteTokens: 0,
      responseTokens: 4,
      totalTokens: 16,
      tokenSource: "provider"
    });
  });

  it("lists wrapper models and filters non-chat IDs", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "gemini-2.5-flash"
            },
            {
              id: "text-embedding-004"
            }
          ]
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        }
      )
    );

    await expect(new GeminiWrapperClient("http://localhost:8787/v1", "", undefined, "http").listModels()).resolves.toEqual(["auto", "flash-lite", "flash", "pro", "thinking", "gemini-2.5-flash"]);
  });

  it("caches wrapper model descriptors for repeated model listings", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: "gemini-2.5-flash" }]
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        }
      )
    );
    const client = new GeminiWrapperClient("http://localhost:8787/v1", "", undefined, "http");

    await expect(client.listModels()).resolves.toContain("gemini-2.5-flash");
    await expect(client.listModelDescriptors()).resolves.toContainEqual(expect.objectContaining({ id: "gemini-2.5-flash" }));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("requires browser-cookie3 for browser cookie bridge readiness", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "patchpilot-gemini-ready-deps-"));
    try {
      const modulePath = path.join(tempRoot, "gemini_webapi.py");
      const pythonShimPath = path.join(tempRoot, "python-shim");
      await writeFile(modulePath, "", "utf8");
      await writeFile(pythonShimPath, `#!/bin/sh\nPYTHONPATH="${tempRoot}" python3 "$@"\n`, "utf8");
      await chmod(pythonShimPath, 0o755);

      await expect(isGeminiBrowserCookieImportInstalled(pythonShimPath)).resolves.toBe(false);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("memoizes Python bridge readiness checks for repeated chats", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "patchpilot-gemini-ready-"));
    const originalConfigDir = process.env.PATCHPILOT_CONFIG_DIR;
    try {
      process.env.PATCHPILOT_CONFIG_DIR = tempRoot;
      const modulePath = path.join(tempRoot, "gemini_webapi.py");
      const pythonShimPath = path.join(tempRoot, "python-shim");
      const cookiesPath = path.join(tempRoot, "cookies.json");
      const checksPath = path.join(tempRoot, "checks.log");

      await writeFile(
        modulePath,
        [
          "class Response:",
          "    text = 'ok from bridge'",
          "",
          "class GeminiClient:",
          "    def __init__(self, *args, **kwargs):",
          "        pass",
          "",
          "    async def init(self, *args, **kwargs):",
          "        pass",
          "",
          "    async def generate_content(self, prompt, **kwargs):",
          "        return Response()",
          "",
          "    async def close(self):",
          "        pass",
          ""
        ].join("\n"),
        "utf8"
      );
      await writeFile(
        pythonShimPath,
        `#!/bin/sh\nif [ "$1" = "-c" ] && [ "$2" = "import gemini_webapi" ]; then\n  printf 'check\\n' >> "${checksPath}"\nfi\nPYTHONPATH="${tempRoot}" python3 "$@"\n`,
        "utf8"
      );
      await chmod(pythonShimPath, 0o755);
      await writeFile(cookiesPath, JSON.stringify({ cookies: { "__Secure-1PSID": "psid-value" } }), "utf8");

      const client = new GeminiWrapperClient("", "", { maxTokens: 256, temperature: 0.2, bridgeMinIntervalMs: 0 }, "python", pythonShimPath, cookiesPath);
      const request = {
        model: "gemini-3-flash",
        messages: [
          {
            role: "user" as const,
            content: "hello"
          }
        ]
      };

      await expect(client.chat(request)).resolves.toMatchObject({ content: "ok from bridge" });
      await expect(client.chat(request)).resolves.toMatchObject({ content: "ok from bridge" });

      await expect(readFile(checksPath, "utf8")).resolves.toBe("check\n");
    } finally {
      if (originalConfigDir === undefined) {
        delete process.env.PATCHPILOT_CONFIG_DIR;
      } else {
        process.env.PATCHPILOT_CONFIG_DIR = originalConfigDir;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps the Gemini Web client warm across chats through the bridge daemon", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "patchpilot-gemini-daemon-"));
    const originalConfigDir = process.env.PATCHPILOT_CONFIG_DIR;
    try {
      process.env.PATCHPILOT_CONFIG_DIR = tempRoot;
      const modulePath = path.join(tempRoot, "gemini_webapi.py");
      const pythonShimPath = path.join(tempRoot, "python-shim");
      const cookiesPath = path.join(tempRoot, "cookies.json");
      const initCounterPath = path.join(tempRoot, "init-count.txt");

      await writeFile(
        modulePath,
        [
          "from pathlib import Path",
          "",
          `INIT_COUNTER = Path(${JSON.stringify(initCounterPath)})`,
          "",
          "class Status:",
          "    name = 'AVAILABLE'",
          "",
          "class Response:",
          "    text = 'ok from warm client'",
          "",
          "class GeminiClient:",
          "    def __init__(self, *args, **kwargs):",
          "        self.account_status = Status()",
          "",
          "    async def init(self, *args, **kwargs):",
          "        count = int(INIT_COUNTER.read_text() or '0') if INIT_COUNTER.exists() else 0",
          "        INIT_COUNTER.write_text(str(count + 1))",
          "",
          "    async def generate_content(self, prompt, **kwargs):",
          "        return Response()",
          "",
          "    async def close(self):",
          "        pass",
          ""
        ].join("\n"),
        "utf8"
      );
      await writeFile(pythonShimPath, `#!/bin/sh\nPYTHONPATH="${tempRoot}" python3 "$@"\n`, "utf8");
      await chmod(pythonShimPath, 0o755);
      await writeFile(cookiesPath, JSON.stringify({ cookies: { "__Secure-1PSID": "psid-value" } }), "utf8");

      const client = new GeminiWrapperClient("", "", { maxTokens: 256, temperature: 0.2, bridgeMinIntervalMs: 0 }, "python", pythonShimPath, cookiesPath);
      const request = {
        model: "gemini-3-flash",
        messages: [
          {
            role: "user" as const,
            content: "hello"
          }
        ]
      };

      await expect(client.chat(request)).resolves.toMatchObject({ content: "ok from warm client" });
      await expect(client.chat(request)).resolves.toMatchObject({ content: "ok from warm client" });

      // One init for two chats — the daemon reused the initialized client.
      await expect(readFile(initCounterPath, "utf8")).resolves.toBe("1");
    } finally {
      disposeGeminiWrapperBridgeDaemon();
      if (originalConfigDir === undefined) {
        delete process.env.PATCHPILOT_CONFIG_DIR;
      } else {
        process.env.PATCHPILOT_CONFIG_DIR = originalConfigDir;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("includes response body details for non-JSON wrapper errors", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response("<html>bad gateway</html>", {
          status: 502,
          headers: {
            "retry-after": "3"
          }
        })
      )
      .mockResolvedValueOnce(
        new Response("<html>bad gateway</html>", {
          status: 502,
          headers: {
            "retry-after": "3"
          }
        })
      );

    await expect(new GeminiWrapperClient("http://localhost:8787/v1", "", undefined, "http").listModels()).rejects.toThrow(/bad gateway.*retry-after 3s/);
  });
});
