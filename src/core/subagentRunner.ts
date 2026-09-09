import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentEvent, ModelClient } from "./types.js";
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
 *   3. **Children run serialised.** Each one starts with a cold prefix cache;
 *      running two at once on one machine evicts the parent's cache as well.
 */

/** Hard cap on what a child returns. Enforced here, never requested in prose. */
export const maxEnvelopeChars = 1200;

export type SubagentType = "explore" | "general";

export type SubagentRequest = {
  type: SubagentType;
  description: string;
  prompt: string;
};

export type SubagentEnvelope = {
  status: "ok" | "failed" | "aborted";
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
};

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
  const transcript: string[] = [`# ${request.description}`, `type: ${request.type}`, "", `## Task`, request.prompt, "", "## Trace"];

  let steps = 0;
  let toolCalls = 0;
  let finalMessage = "";
  let status: SubagentEnvelope["status"] = "failed";

  try {
    for await (const event of deps.run({ task: request.prompt, readOnly: access.readOnly, client: deps.client })) {
      if (deps.signal?.aborted) {
        finalMessage = "Stopped.";
        status = "aborted";
        break;
      }

      switch (event.type) {
        case "metrics":
          steps += 1;
          break;
        case "tool":
          toolCalls += 1;
          transcript.push(`- ${event.name} ${event.ok ? "ok" : "failed"}: ${event.summary}`);
          if (event.content) {
            transcript.push("", "```", event.content, "```", "");
          }
          break;
        case "assistant":
          transcript.push("", event.message, "");
          break;
        case "final":
          finalMessage = event.message;
          status = /^Stopped\b/i.test(event.message) ? "aborted" : "ok";
          break;
        case "error":
          finalMessage = event.message;
          status = "failed";
          break;
        default:
          break;
      }
    }
  } catch (error) {
    finalMessage = error instanceof Error ? error.message : String(error);
    status = deps.signal?.aborted ? "aborted" : "failed";
  }

  const transcriptPath = await writeTranscript(deps.transcriptDir, request.description, transcript.join("\n"));

  return {
    status,
    description: request.description,
    summary: clampSummary(finalMessage || "The subagent produced no answer."),
    steps,
    durationMs: now() - startedAt,
    toolCalls,
    transcript: transcriptPath
  };
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

async function writeTranscript(directory: string, description: string, body: string): Promise<string | null> {
  try {
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, `${slug(description)}-${Date.now()}.md`);
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
