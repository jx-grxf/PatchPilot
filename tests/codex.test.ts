import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexCliClient, codexOAuthModels, hasCodexCliOAuth } from "../src/core/codex.js";
import { normalizeModelProvider } from "../src/core/modelClient.js";

let tempRoot = "";

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), "patchpilot-codex-"));
});

afterEach(async () => {
  await rm(tempRoot, {
    recursive: true,
    force: true
  });
});

describe("Codex OAuth provider", () => {
  it("detects Codex CLI OAuth tokens without reading them as API keys", async () => {
    const authPath = path.join(tempRoot, "auth.json");
    await writeFile(
      authPath,
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: "access",
          refresh_token: "refresh"
        }
      })
    );

    expect(hasCodexCliOAuth(authPath)).toBe(true);
  });

  it("lists supported Codex OAuth models statically", async () => {
    await expect(new CodexCliClient({ workspace: tempRoot }).listModels()).resolves.toEqual(codexOAuthModels);
  });

  it("normalizes OpenAI Codex provider aliases", () => {
    expect(normalizeModelProvider("codex")).toBe("codex");
    expect(normalizeModelProvider("openai-codex")).toBe("codex");
    expect(normalizeModelProvider("openai")).toBe("codex");
  });
});
