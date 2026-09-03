import { spawn } from "node:child_process";
import { describeComputeTarget } from "./compute.js";
import { LocalOpenAIClient, resolveLocalOpenAIBaseUrl } from "./localOpenAI.js";
import { OllamaClient } from "./ollama.js";
import type { ModelProvider } from "./types.js";

export type DoctorResult = {
  name: string;
  ok: boolean;
  details: string;
  action?: "check" | "fix" | "skipped";
};

export async function runDoctor(
  provider: ModelProvider,
  ollamaUrl: string,
  model?: string,
  options: { fix?: boolean; localUrl?: string } = {}
): Promise<DoctorResult[]> {
  const results: DoctorResult[] = [];

  results.push(await checkCommand("node", ["--version"]));
  results.push(await checkCommand("git", ["--version"]));

  if (provider === "local-openai") {
    results.push(...(await checkLocalOpenAI(options.localUrl ?? resolveLocalOpenAIBaseUrl(), model)));
    return results;
  }

  results.push(...(await checkOllama(ollamaUrl, model)));
  return results;
}

async function checkOllama(ollamaUrl: string, model?: string): Promise<DoctorResult[]> {
  const results: DoctorResult[] = [];
  const computeTarget = describeComputeTarget(ollamaUrl);

  if (computeTarget.kind === "local") {
    results.push(
      await checkCommand("ollama", ["--version"], "ollama-cli", "Install Ollama and ensure the ollama CLI is available on PATH.")
    );
  } else {
    results.push({
      name: "ollama-cli",
      ok: true,
      details: `not required locally while using ${computeTarget.label}`
    });
  }

  const ollama = new OllamaClient(ollamaUrl);
  let models: string[] = [];
  try {
    models = await ollama.listModels();
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
    return results;
  }

  if (model) {
    const isAvailable = models.includes(model);
    results.push({
      name: "ollama-model",
      ok: isAvailable,
      details: isAvailable ? `${model} is available` : `${model} is missing. Run: ollama pull ${model}`
    });
  }

  results.push(await checkOllamaContextWindow(ollama, model));
  return results;
}

/**
 * The context window the harness sends (`num_ctx`) and the one the runtime
 * actually loaded can differ — a model loaded by another client keeps whatever
 * window that client asked for. Reporting the loaded value is the only way to
 * know how much room the agent really has.
 */
async function checkOllamaContextWindow(ollama: OllamaClient, model?: string): Promise<DoctorResult> {
  try {
    const running = await ollama.listRunningModels();
    if (running.length === 0) {
      return {
        name: "context-window",
        ok: true,
        details: "no model loaded yet; window is reported once a model is running",
        action: "skipped"
      };
    }

    const loaded = model ? running.find((entry) => entry.name === model) ?? running[0] : running[0];
    if (!loaded) {
      return { name: "context-window", ok: true, details: "no model loaded", action: "skipped" };
    }

    return {
      name: "context-window",
      ok: true,
      details:
        loaded.contextLength === null
          ? `${loaded.name} is loaded; runtime did not report a context length`
          : `${loaded.name} loaded with a ${loaded.contextLength.toLocaleString("en-US")} token window`
    };
  } catch (error) {
    return {
      name: "context-window",
      ok: false,
      details: error instanceof Error ? error.message : String(error)
    };
  }
}

async function checkLocalOpenAI(baseUrl: string, model?: string): Promise<DoctorResult[]> {
  const results: DoctorResult[] = [];
  const client = new LocalOpenAIClient(baseUrl);

  try {
    const descriptors = await client.listModelDescriptors();
    results.push({
      name: "local-server",
      ok: true,
      details:
        descriptors.length > 0
          ? `${baseUrl} reachable; models: ${descriptors.map((entry) => entry.id).join(", ")}`
          : `${baseUrl} reachable, but no models are served`
    });

    if (model) {
      const match = descriptors.find((entry) => entry.id === model);
      results.push({
        name: "local-model",
        ok: Boolean(match),
        details: match
          ? `${model} is available${match.isAvailable === false ? " (not loaded; it will load on first request)" : ""}`
          : `${model} is not served by ${baseUrl}. Load it in your local server, or pick one of the listed ids.`
      });

      results.push({
        name: "context-window",
        ok: true,
        details:
          match?.capacity === undefined
            ? "server did not report a context length for this model"
            : `${model} advertises a ${match.capacity.toLocaleString("en-US")} token window`,
        ...(match?.capacity === undefined ? { action: "skipped" as const } : {})
      });
    }
  } catch (error) {
    results.push({
      name: "local-server",
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
