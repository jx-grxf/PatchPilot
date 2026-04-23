import { spawn } from "node:child_process";
import { describeComputeTarget } from "./compute.js";
import { OllamaClient } from "./ollama.js";

export type DoctorResult = {
  name: string;
  ok: boolean;
  details: string;
};

export async function runDoctor(ollamaUrl: string, model?: string): Promise<DoctorResult[]> {
  const results: DoctorResult[] = [];

  results.push(await checkCommand("node", ["--version"]));
  results.push(await checkCommand("git", ["--version"]));

  const computeTarget = describeComputeTarget(ollamaUrl);
  if (computeTarget.kind === "local") {
    results.push(
      await checkCommand(
        "ollama",
        ["--version"],
        "ollama-cli",
        "Install Ollama and ensure the ollama CLI is available on PATH."
      )
    );
  } else {
    results.push({
      name: "ollama-cli",
      ok: true,
      details: `not required locally while using ${computeTarget.label}`
    });
  }

  const ollama = new OllamaClient(ollamaUrl);
  try {
    const models = await ollama.listModels();
    results.push({
      name: "ollama",
      ok: true,
      details: models.length > 0 ? `available models: ${models.join(", ")}` : "server reachable, no models pulled"
    });
    if (model) {
      results.push({
        name: "ollama-model",
        ok: models.includes(model),
        details: models.includes(model) ? `${model} is available` : `${model} is missing. Run: ollama pull ${model}`
      });
    }
  } catch (error) {
    results.push({
      name: "ollama",
      ok: false,
      details: error instanceof Error ? error.message : String(error)
    });
  }

  return results;
}

function checkCommand(command: string, args: string[], name = command, missingHint?: string): Promise<DoctorResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      windowsHide: true
    });

    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      resolve({
        name,
        ok: false,
        details: missingHint ? `${error.message}. ${missingHint}` : error.message
      });
    });

    child.on("close", (exitCode) => {
      resolve({
        name,
        ok: exitCode === 0,
        details: output.trim()
      });
    });
  });
}
