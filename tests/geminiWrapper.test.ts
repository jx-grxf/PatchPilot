import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GeminiWrapperClient,
  geminiWrapperRequiresApiKey,
  getDefaultGeminiWrapperCookiesPath,
  getGeminiWrapperCookieCacheDir,
  getGeminiWrapperVenvDir,
  getManagedGeminiWrapperPythonPath,
  readGeminiWrapperApiKey,
  readGeminiWrapperBaseUrl,
  readGeminiWrapperBootstrapPythonCommand,
  readGeminiWrapperCookiesJson,
  readGeminiWrapperMode,
  readGeminiWrapperPythonCommand,
  saveGeminiWrapperCookieFile
} from "../src/core/geminiWrapper.js";
import { normalizeModelProvider } from "../src/core/modelClient.js";

afterEach(() => {
  vi.restoreAllMocks();
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
    const env = {
      PATCHPILOT_CONFIG_DIR: "/tmp/patchpilot-test-config"
    } as NodeJS.ProcessEnv;
    expect(getGeminiWrapperVenvDir(env)).toBe("/tmp/patchpilot-test-config/gemini-wrapper-venv");
    expect(getGeminiWrapperCookieCacheDir(env)).toBe("/tmp/patchpilot-test-config/gemini-webapi-cache");
    expect(readGeminiWrapperPythonCommand(env)).toBe(getManagedGeminiWrapperPythonPath(env));
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
          "    async def init(self, timeout=90, auto_refresh=False, verbose=False):",
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
      await expect(client.chat({ model: "flash", messages: [{ role: "user", content: "hello" }] })).resolves.toMatchObject({
        content: '{"model": "flash35-id"}'
      });
      await expect(client.chat({ model: "thinking", messages: [{ role: "user", content: "hello" }] })).resolves.toMatchObject({
        content: '{"model": "gemini-3-flash-thinking"}'
      });
      await expect(client.chat({ model: "pro", messages: [{ role: "user", content: "hello" }] })).resolves.toMatchObject({
        content: '{"model": "pro-id"}'
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

  it("requires explicit bridge auth and does not fall back to browser cookies", async () => {
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
    ).rejects.toThrow("PatchPilot will not scan browser cookies");
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

  it("includes response body details for non-JSON wrapper errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
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
