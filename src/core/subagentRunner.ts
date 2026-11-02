import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentEvent, AgentEventToolName, ModelClient } from "./types.js";
import type { ToolName } from "./toolSchema.js";

/**
 * Child agent loops with isolated context.
 *
 * The point of a subagent is not parallelism — on one GPU there is none to be
 * had — it is **context isolation**. A child can burn 50k tokens exploring and
 * return 500, and on an 8k-to-32k window that is the difference between
 * finishing a task and running out of room halfway through.
 *
 * Three rules make delegation pay rather than cost:
 *
 *   1. **The envelope is bounded by the harness, not by asking nicely.** An
 *      unbounded "summary" from a small model re-narrates everything it read,
 *      which is exactly what delegation was supposed to avoid.
 *   2. **The full transcript goes to disk and the envelope carries its path.**
 *      The parent can read it with the tool it already has, on the rare
 *      occasion it needs detail. This costs no extra inference, unlike
 *      summarising.
 *   3. **Concurrency is bounded.** Each child starts with a cold prefix cache,
 *      so only a few run at once (`subagentConcurrency`); a local server batches
 *      them, and further children wait their turn. Writers are kept apart by the
 *      write coordinator rather than by running one at a time.
 */

/**
 * How many children run at once. Two is what a 24 GB Mac serves as one batch
 * without slowing the parent's own requests noticeably.
 */
export function subagentConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number.parseInt(env.PATCHPILOT_SUBAGENT_CONCURRENCY ?? "", 10);
  return Number.isFinite(configured) ? Math.min(4, Math.max(1, configured)) : 2;
}

/** Hard cap on what a child returns. Enforced here, never requested in prose. */
export const maxEnvelopeChars = 1200;

export type SubagentType = "explore" | "general";

export type SubagentRequest = {
  type: SubagentType;
  description: string;
  prompt: string;
};

export type SubagentEnvelope = {
  /** `incomplete` means the child hit its step cap: the summary is partial. */
  status: "ok" | "failed" | "aborted" | "incomplete";
  description: string;
  summary: string;
  steps: number;
  durationMs: number;
  toolCalls: number;
  /** Where the full transcript was written, for the parent to read on demand. */
  transcript: string | null;
};

/** Tools each child type may use. Absent tools cannot be called at all. */
export const subagentToolAccess: Record<SubagentType, { readOnly: boolean; description: string }> = {
  explore: {
    readOnly: true,
    description: "reads and reports; cannot change anything"
  },
  general: {
    readOnly: false,
    description: "can read, search and edit files"
  }
};

export type SubagentDependencies = {
  /** Runs one child loop and yields its events, exactly like the parent loop. */
  run: (options: {
    task: string;
    readOnly: boolean;
    client: ModelClient;
  }) => AsyncGenerator<AgentEvent, void>;
  client: ModelClient;
  /** Directory for transcripts, normally .patchpilot/subagents. */
  transcriptDir: string;
  signal?: AbortSignal;
  now?: () => number;
  /** Called on every tool call the child makes, so the UI can show it working. */
  onProgress?: (progress: { toolCalls: number; activity: { name: AgentEventToolName; arguments: Record<string, unknown> } }) => void;
};

/**
 * Collects one child run into an envelope. Shared by the blocking path and the
 * supervisor, which both feed it the child's events.
 */
export class SubagentTrace {
  steps = 0;
  toolCalls = 0;
  private finalMessage = "";
  private status: SubagentEnvelope["status"] = "failed";
  private readonly lines: string[];

  constructor(
    private readonly request: SubagentRequest,
    private readonly startedAt: number
  ) {
    this.lines = [`# ${request.description}`, `type: ${request.type}`, "", `## Task`, request.prompt, "", "## Trace"];
  }

  record(event: AgentEvent): void {
    switch (event.type) {
      case "metrics":
        this.steps += 1;
        break;
      case "tool":
        this.toolCalls += 1;
        this.lines.push(`- ${event.name} ${event.ok ? "ok" : "failed"}: ${event.summary}`);
        if (event.content) {
          this.lines.push("", "```", event.content, "```", "");
        }
        break;
      case "assistant":
        this.lines.push("", event.message, "");
        break;
      case "final":
        this.finalMessage = event.message;
        this.status = event.stoppedBy === "step_limit" ? "incomplete" : /^Stopped\b/i.test(event.message) ? "aborted" : "ok";
        break;
      case "error":
        this.finalMessage = event.message;
        this.status = "failed";
        break;
      default:
        break;
    }
  }

  markAborted(): void {
    this.finalMessage = "Stopped.";
    this.status = "aborted";
  }

  fail(error: unknown, aborted: boolean): void {
    this.finalMessage = error instanceof Error ? error.message : String(error);
    this.status = aborted ? "aborted" : "failed";
  }

  async finish(transcriptDir: string, now: number, label?: string): Promise<SubagentEnvelope> {
    const transcript = await writeTranscript(transcriptDir, this.request.description, this.lines.join("\n"), label);
    return {
      status: this.status,
      description: this.request.description,
      summary: clampSummary(this.finalMessage || "The subagent produced no answer."),
      steps: this.steps,
      durationMs: now - this.startedAt,
      toolCalls: this.toolCalls,
      transcript
    };
  }
}

/**
 * Runs one subagent to completion and returns its bounded envelope.
 *
 * Never throws: a child that fails is a result the parent has to reason about,
 * not an exception that ends the parent's run.
 */
export async function runSubagent(request: SubagentRequest, deps: SubagentDependencies): Promise<SubagentEnvelope> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const access = subagentToolAccess[request.type];
  const trace = new SubagentTrace(request, startedAt);

  try {
    for await (const event of deps.run({ task: request.prompt, readOnly: access.readOnly, client: deps.client })) {
      if (deps.signal?.aborted) {
        trace.markAborted();
        break;
      }
      trace.record(event);
      if (event.type === "tool") {
        deps.onProgress?.({ toolCalls: trace.toolCalls, activity: { name: event.name, arguments: event.arguments ?? {} } });
      }
    }
  } catch (error) {
    trace.fail(error, Boolean(deps.signal?.aborted));
  }

  return await trace.finish(deps.transcriptDir, now());
}

/**
 * Formats an envelope for the parent's tool result. Short by construction, and
 * it always names the transcript so the parent knows detail is available
 * without having to be told.
 */
export function formatEnvelope(envelope: SubagentEnvelope): string {
  const parts = [
    `[${envelope.status}] ${envelope.description}`,
    envelope.summary,
    `(${envelope.steps} step${envelope.steps === 1 ? "" : "s"}, ${envelope.toolCalls} tool call${envelope.toolCalls === 1 ? "" : "s"}, ${Math.round(envelope.durationMs / 1000)}s)`
  ];

  if (envelope.status === "incomplete") {
    parts.push(
      `This result is partial: the agent hit its step limit before finishing. Report what it found and say what is missing; do not present it as complete or fill the gaps from your own knowledge. Continue it with task action "message" only if the missing part is needed to answer.`
    );
  }

  if (envelope.transcript) {
    parts.push(`Full transcript: ${envelope.transcript} — read it only if you need detail this summary omits.`);
  }

  return parts.join("\n");
}

/**
 * Truncates at a sentence boundary where one is near the limit, so a clipped
 * summary still reads as a sentence rather than stopping mid-word.
 */
export function clampSummary(summary: string): string {
  const normalized = summary.trim().replace(/\s+/g, " ");
  if (normalized.length <= maxEnvelopeChars) {
    return normalized;
  }

  const window = normalized.slice(0, maxEnvelopeChars);
  const lastSentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
  const cut = lastSentence > maxEnvelopeChars * 0.6 ? lastSentence + 1 : maxEnvelopeChars - 1;
  return `${window.slice(0, cut).trimEnd()}…`;
}

/** Exact public tool surface advertised to a child. Shell and recursion stay absent. */
export function subagentToolNames(readOnly: boolean): ToolName[] {
  const readTools: ToolName[] = ["read", "glob", "grep"];
  return readOnly ? readTools : [...readTools, "write", "edit"];
}

async function writeTranscript(directory: string, description: string, body: string, label?: string): Promise<string | null> {
  try {
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, `${label ? `${label}-` : ""}${slug(description)}-${Date.now()}.md`);
    await writeFile(file, `${body}\n`, "utf8");
    return file;
  } catch {
    // A missing transcript costs the parent detail it can usually do without;
    // it must never fail the delegation.
    return null;
  }
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "subagent"
  );
}
