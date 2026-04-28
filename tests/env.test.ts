import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPatchPilotEnvPath, loadDotEnv, loadPatchPilotEnv, saveDotEnvValues, savePatchPilotEnvValues } from "../src/core/env.js";

let tempRoot = "";
let previousEnv: string | undefined;
let previousModel: string | undefined;
let previousGeminiKey: string | undefined;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), "patchpilot-env-"));
  previousEnv = process.env.PATCHPILOT_PROVIDER;
  previousModel = process.env.PATCHPILOT_MODEL;
  previousGeminiKey = process.env.GEMINI_API_KEY;
  delete process.env.PATCHPILOT_PROVIDER;
  delete process.env.PATCHPILOT_MODEL;
  delete process.env.GEMINI_API_KEY;
});

afterEach(async () => {
  if (previousEnv === undefined) {
    delete process.env.PATCHPILOT_PROVIDER;
  } else {
    process.env.PATCHPILOT_PROVIDER = previousEnv;
  }

  if (previousModel === undefined) {
    delete process.env.PATCHPILOT_MODEL;
  } else {
    process.env.PATCHPILOT_MODEL = previousModel;
  }

  if (previousGeminiKey === undefined) {
    delete process.env.GEMINI_API_KEY;
  } else {
    process.env.GEMINI_API_KEY = previousGeminiKey;
  }

  await rm(tempRoot, {
    recursive: true,
    force: true
  });
});

describe("dotenv helpers", () => {
  it("loads .env values without overriding existing process env", async () => {
    process.env.PATCHPILOT_PROVIDER = "ollama";
    await writeFile(path.join(tempRoot, ".env"), "PATCHPILOT_PROVIDER=gemini\nPATCHPILOT_MODEL=gemini-2.5-flash\n");

    loadDotEnv(tempRoot);

    expect(process.env.PATCHPILOT_PROVIDER).toBe("ollama");
    expect(process.env.PATCHPILOT_MODEL).toBe("gemini-2.5-flash");
  });

  it("updates existing .env keys and appends missing keys", async () => {
    await writeFile(path.join(tempRoot, ".env"), "PATCHPILOT_PROVIDER=ollama\n");

    saveDotEnvValues(
      {
        PATCHPILOT_PROVIDER: "gemini",
        GEMINI_API_KEY: "secret key"
      },
      tempRoot
    );

    await expect(readFile(path.join(tempRoot, ".env"), "utf8")).resolves.toBe('PATCHPILOT_PROVIDER=gemini\nGEMINI_API_KEY="secret key"\n');
  });

  it("loads PatchPilot config from the same .env path it saves", async () => {
    savePatchPilotEnvValues(
      {
        GEMINI_API_KEY: "persisted-key"
      },
      {
        PATCHPILOT_CONFIG_DIR: tempRoot
      } as NodeJS.ProcessEnv
    );

    expect(getPatchPilotEnvPath({ PATCHPILOT_CONFIG_DIR: tempRoot } as NodeJS.ProcessEnv)).toBe(path.join(tempRoot, ".env"));
    loadPatchPilotEnv({ PATCHPILOT_CONFIG_DIR: tempRoot } as NodeJS.ProcessEnv);

    expect(process.env.GEMINI_API_KEY).toBe("persisted-key");
  });
});
