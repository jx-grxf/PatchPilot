import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { AgentRunner } from "./agent.js";
import type { AgentEvent, ChatMessage, ModelProvider } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * A handful of fixed tasks that exercise what breaks first on a small local
 * model: making a file, a follow-up that only works with the conversation
 * kept, and a targeted edit. Each is checked by running or reading the result,
 * never by asking the model whether it succeeded.
 */
type BenchCase = {
  name: string;
  setup?: (dir: string) => Promise<void>;
  turns: string[];
  check: (dir: string) => Promise<string | null>;
};

const cases: BenchCase[] = [
  {
    name: "create",
    turns: ["Create fizzbuzz.js that prints FizzBuzz for 1 to 15, one value per line."],
    check: async (dir) => {
      const { stdout } = await execFileAsync("node", ["fizzbuzz.js"], { cwd: dir, timeout: 10_000 });
      const lines = stdout.trim().split("\n");
      return lines[14]?.trim() === "FizzBuzz" && lines[2]?.trim() === "Fizz" ? null : `unexpected output: ${stdout.slice(0, 80)}`;
    }
  },
  {
    name: "follow-up",
    turns: ["Create greet.js exporting a function greet(name) that returns \"Hello, <name>!\".", "Now add code at the bottom of that file that prints greet(\"World\")."],
    check: async (dir) => {
      const { stdout } = await execFileAsync("node", ["greet.js"], { cwd: dir, timeout: 10_000 });
      return stdout.includes("Hello, World!") ? null : `unexpected output: ${stdout.slice(0, 80)}`;
    }
  },
  {
    name: "edit",
    setup: async (dir) => {
      await writeFile(path.join(dir, "config.json"), JSON.stringify({ name: "demo", port: 3000, debug: false }, null, 2));
    },
    turns: ["Change the port in config.json to 8080. Leave everything else as it is."],
    check: async (dir) => {
      const config = JSON.parse(await readFile(path.join(dir, "config.json"), "utf8")) as Record<string, unknown>;
      return config.port === 8080 && config.name === "demo" && config.debug === false ? null : `config is ${JSON.stringify(config)}`;
    }
  }
];

export type BenchResult = {
  name: string;
  ok: boolean;
  detail: string;
  seconds: number;
  modelCalls: number;
  toolCalls: number;
  failedToolCalls: number;
  tokensPerSecond: number | null;
};

export async function runBench(options: {
  provider: ModelProvider;
  model: string;
  ollamaUrl: string;
  onResult?: (result: BenchResult) => void;
}): Promise<BenchResult[]> {
  const results: BenchResult[] = [];
  for (const benchCase of cases) {
    const dir = await mkdtemp(path.join(tmpdir(), `patchpilot-bench-${benchCase.name}-`));
    const started = Date.now();
    const conversation: ChatMessage[] = [];
    let modelCalls = 0;
    let toolCalls = 0;
    let failedToolCalls = 0;
    let responseTokens = 0;
    let generationMs = 0;
    let detail = "";
    try {
      await benchCase.setup?.(dir);
      for (const turn of benchCase.turns) {
        const runner = new AgentRunner({
          provider: options.provider,
          model: options.model,
          ollamaUrl: options.ollamaUrl,
          workspace: dir,
          mode: "bypass",
          allowWrite: true,
          allowShell: true,
          maxSteps: 30,
          subagents: false,
          conversation
        });
        for await (const event of runner.run(turn) as AsyncGenerator<AgentEvent>) {
          if (event.type === "metrics") {
            modelCalls += 1;
            responseTokens += event.metrics.responseTokens;
            generationMs += Math.max(0, event.metrics.totalDurationMs - (event.metrics.timeToFirstTokenMs ?? 0));
          } else if (event.type === "tool") {
            toolCalls += 1;
            failedToolCalls += event.ok ? 0 : 1;
          }
        }
      }
      detail = (await benchCase.check(dir).catch((error: unknown) => (error instanceof Error ? error.message : String(error)))) ?? "";
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    const result: BenchResult = {
      name: benchCase.name,
      ok: detail === "",
      detail,
      seconds: (Date.now() - started) / 1000,
      modelCalls,
      toolCalls,
      failedToolCalls,
      tokensPerSecond: generationMs > 0 ? responseTokens / (generationMs / 1000) : null
    };
    results.push(result);
    options.onResult?.(result);
  }
  return results;
}
