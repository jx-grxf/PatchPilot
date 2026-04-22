import { spawn } from "node:child_process";
import { OllamaClient } from "./ollama.js";

export type DoctorResult = {
  name: string;
  ok: boolean;
  details: string;
};

export async function runDoctor(ollamaUrl: string): Promise<DoctorResult[]> {
  const results: DoctorResult[] = [];

  results.push(await checkCommand("node", ["--version"]));
  results.push(await checkCommand("git", ["--version"]));

  const ollama = new OllamaClient(ollamaUrl);
  try {
    const models = await ollama.listModels();
    results.push({
      name: "ollama",
      ok: true,
      details: models.length > 0 ? `available models: ${models.join(", ")}` : "server reachable, no models pulled"
    });
  } catch (error) {
    results.push({
      name: "ollama",
      ok: false,
      details: error instanceof Error ? error.message : String(error)
    });
  }

  return results;
}

function checkCommand(command: string, args: string[]): Promise<DoctorResult> {
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
        name: command,
        ok: false,
        details: error.message
      });
    });

    child.on("close", (exitCode) => {
      resolve({
        name: command,
        ok: exitCode === 0,
        details: output.trim()
      });
    });
  });
}
