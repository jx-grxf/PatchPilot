import { z } from "zod";
import type { AgentResponse } from "./types.js";

const toolNameSchema = z.enum([
  "list_files",
  "read_file",
  "search_text",
  "inspect_document",
  "write_file",
  "run_shell"
]);

const toolCallSchema = z.object({
  name: toolNameSchema,
  arguments: z.record(z.string(), z.unknown()).default({})
});

const agentResponseSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("tools"),
    message: z.string().default(""),
    tool_calls: z.array(toolCallSchema).min(1)
  }),
  z.object({
    action: z.literal("final"),
    message: z.string()
  })
]);

export function parseAgentResponse(rawContent: string): AgentResponse {
  const parsed = normalizeModelJson(JSON.parse(extractJson(rawContent)));
  return agentResponseSchema.parse(parsed);
}

export function formatParseError(error: unknown): string {
  if (error instanceof z.ZodError) {
    const firstIssue = error.issues[0];
    if (!firstIssue) {
      return "response did not match the PatchPilot protocol.";
    }

    const location = firstIssue.path.length > 0 ? ` at ${firstIssue.path.join(".")}` : "";
    return `${firstIssue.message}${location}`;
  }

  return error instanceof Error ? error.message : String(error);
}

function extractJson(rawContent: string): string {
  const trimmedContent = rawContent.trim();

  if (trimmedContent.startsWith("{") && trimmedContent.endsWith("}")) {
    return trimmedContent;
  }

  const fencedMatch = trimmedContent.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const firstBrace = trimmedContent.indexOf("{");
  const lastBrace = trimmedContent.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmedContent.slice(firstBrace, lastBrace + 1);
  }

  throw new Error("Model response did not contain a JSON object.");
}

function normalizeModelJson(parsed: unknown): unknown {
  if (Array.isArray(parsed)) {
    if (parsed.length === 1) {
      return normalizeModelJson(parsed[0]);
    }

    if (parsed.every(isToolCallLike)) {
      return {
        action: "tools",
        message: "Requesting tools.",
        tool_calls: parsed
      };
    }
  }

  if (isRecord(parsed)) {
    if (!("action" in parsed) && "tool_calls" in parsed) {
      return {
        action: "tools",
        message: readString(parsed.message, "Requesting tools."),
        tool_calls: parsed.tool_calls
      };
    }

    if (!("action" in parsed) && "message" in parsed) {
      return {
        action: "final",
        message: readString(parsed.message, "")
      };
    }
  }

  return parsed;
}

function isToolCallLike(value: unknown): boolean {
  return isRecord(value) && "name" in value && "arguments" in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}
