import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { supportsMlx } from "./localRuntimes.js";

/**
 * Fast MoE coder that fits a 24 GB Mac with room for a long context: 3B
 * active parameters per token, about 13 GB on disk.
 */
export const defaultMlxModel = "mlx-community/Qwen3.6-35B-A3B-OptiQ-4bit-REAP-19B";

export type AutostartPlan =
  | { kind: "use-existing"; baseUrl: string; model: string }
  | { kind: "start-mlx"; model: string; binary: string }
  | { kind: "skip"; reason: string };

export type AutostartResult = { baseUrl: string; model: string; server: ManagedServer | null };

export type ManagedServer = {
  baseUrl: string;
  stop(): void;
};

/**
 * Decides whether PatchPilot has to bring its own model server. A server that
 * is already up and serves the requested model always wins; MLX is started
 * only when nothing usable answers, and only where MLX can run.
 */
export async function planAutostart(options: {
  baseUrl: string;
  model: string;
  env?: NodeJS.ProcessEnv;
  listModels?: (baseUrl: string) => Promise<string[] | null>;
  findBinary?: () => Promise<string | null>;
}): Promise<AutostartPlan> {
  const env = options.env ?? process.env;
  if (/^(0|false|off|no)$/i.test(env.PATCHPILOT_AUTOSTART ?? "")) {
    return { kind: "skip", reason: "autostart is turned off" };
  }

  const listModels = options.listModels ?? fetchModelIds;
  const served = await listModels(options.baseUrl);
  if (served?.includes(options.model)) {
    return { kind: "use-existing", baseUrl: options.baseUrl, model: options.model };
  }

  if (!supportsMlx()) {
    return { kind: "skip", reason: served ? `the server at ${options.baseUrl} does not serve ${options.model}` : `nothing answers at ${options.baseUrl}` };
  }

  const binary = await (options.findBinary ?? findMlxServerBinary)();
  if (!binary) {
    return { kind: "skip", reason: "mlx_lm.server is not installed (pip install mlx-lm)" };
  }

  // A model id that names a Hugging Face repo can be served by MLX directly;
  // anything else was meant for the configured server.
  const model = options.model.includes("/") ? options.model : env.PATCHPILOT_MLX_MODEL ?? defaultMlxModel;
  return { kind: "start-mlx", model, binary };
}

/**
 * Starts mlx_lm.server for the lifetime of this process. The first launch
 * downloads the weights, so readiness is awaited for a long time while
 * progress is reported.
 */
export async function startMlxServer(options: {
  binary: string;
  model: string;
  onProgress?: (message: string) => void;
  readyTimeoutMs?: number;
}): Promise<ManagedServer> {
  const port = await findFreePort(8080);
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const child = spawn(
    options.binary,
    [
      "--model", options.model,
      "--host", "127.0.0.1",
      "--port", String(port),
      // Qwen's recommended sampling for non-thinking coding work; requests
      // may still override it.
      "--temp", "0.7",
      "--top-p", "0.8",
      "--top-k", "20",
      "--max-tokens", "16384",
      // Thinking costs seconds per step on a laptop; turned on per request.
      "--chat-template-args", JSON.stringify({ enable_thinking: false }),
      "--prompt-cache-size", "4",
      "--log-level", "WARNING"
    ],
    { stdio: ["ignore", "ignore", "pipe"], detached: false }
  );

  let lastLine = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    const line = chunk.split(/\r|\n/).map((part) => part.trim()).filter(Boolean).at(-1);
    if (line) {
      lastLine = line;
      if (/%|download|fetch/i.test(line)) {
        options.onProgress?.(line);
      }
    }
  });

  const server: ManagedServer = { baseUrl, stop: () => stopChild(child) };
  stopOnExit(server);

  const deadline = Date.now() + (options.readyTimeoutMs ?? 30 * 60_000);
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`mlx_lm.server exited (${child.exitCode}): ${lastLine || "no output"}`);
    }
    if ((await fetchModelIds(baseUrl)) !== null && (await answersChat(baseUrl, options.model))) {
      return server;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  server.stop();
  throw new Error(`mlx_lm.server did not become ready in time: ${lastLine || "no output"}`);
}

export async function fetchModelIds(baseUrl: string): Promise<string[] | null> {
  try {
    const response = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as { data?: Array<{ id?: string }> };
    return (payload.data ?? []).map((model) => model.id ?? "").filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * mlx_lm.server answers /models before the weights are loaded; only a real
 * one-token completion proves the model is ready. It also warms the cache.
 */
async function answersChat(baseUrl: string, model: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
      signal: AbortSignal.timeout(30 * 60_000)
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function findMlxServerBinary(): Promise<string | null> {
  const candidates = [
    ...(process.env.PATH ?? "").split(path.delimiter).map((dir) => path.join(dir, "mlx_lm.server")),
    path.join(homedir(), ".local", "bin", "mlx_lm.server")
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // try the next one
    }
  }
  return null;
}

async function findFreePort(start: number): Promise<number> {
  for (let port = start; port < start + 50; port += 1) {
    const free = await new Promise<boolean>((resolve) => {
      const probe = createServer()
        .once("error", () => resolve(false))
        .once("listening", () => probe.close(() => resolve(true)))
        .listen(port, "127.0.0.1");
    });
    if (free) {
      return port;
    }
  }
  throw new Error(`no free port between ${start} and ${start + 49}`);
}

function stopChild(child: ChildProcess): void {
  if (child.exitCode === null && !child.killed) {
    child.kill("SIGTERM");
  }
}

/** The server holds ~13 GB of memory; it must not outlive PatchPilot. */
function stopOnExit(server: ManagedServer): void {
  process.once("exit", server.stop);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => {
      server.stop();
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
}
