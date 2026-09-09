import { z } from "zod";
import { AGENT_TOOL_NAMES, MAX_TOOL_CALLS_PER_RESPONSE, type AgentResponse } from "./types.js";

const toolNameSchema = z.enum(AGENT_TOOL_NAMES);

const toolCallSchema = z.object({
  name: toolNameSchema,
  arguments: z.record(z.string(), z.unknown()).default({})
});

const agentResponseSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("tools"),
    message: z.string().default(""),
    tool_calls: z.array(toolCallSchema).min(1).max(MAX_TOOL_CALLS_PER_RESPONSE)
  }),
  z.object({
    action: z.literal("final"),
    message: z.string()
  })
]);

export function parseAgentResponse(rawContent: string): AgentResponse {
  const jsonContent = extractJson(rawContent);
  const parsed = normalizeModelJson(parseJsonWithRepair(jsonContent));
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

function parseJsonWithRepair(jsonContent: string): unknown {
  try {
    return JSON.parse(jsonContent);
  } catch (error) {
    // Local models routinely emit invalid JSON when a string value
    // carries file content — literal newlines/tabs and stray backslashes
    // (Windows paths, regex, code). Repair the string contents and retry on
    // any syntax error so "search the code and show me that snippet" works.
    if (!(error instanceof SyntaxError)) {
      throw error;
    }

    try {
      return JSON.parse(repairJsonStrings(jsonContent));
    } catch {
      // Surface the original, more descriptive error if the repair did not help.
      throw error;
    }
  }
}

// The only escape characters JSON permits after a backslash.
const validJsonEscapes = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

/**
 * Repair the inside of JSON string literals: escape literal control characters
 * (newlines/tabs the model forgot to escape) and double any stray backslash
 * that is not a valid JSON escape, so file content survives JSON.parse.
 */
function repairJsonStrings(jsonContent: string): string {
  const chars = [...jsonContent];
  let repaired = "";
  let insideString = false;

  for (let index = 0; index < chars.length; index += 1) {
    const character = chars[index]!;

    if (!insideString) {
      // Drop control-character noise sitting between JSON tokens.
      if (character.charCodeAt(0) < 0x20) {
        continue;
      }
      repaired += character;
      if (character === "\"") {
        insideString = true;
      }
      continue;
    }

    if (character === "\"") {
      repaired += character;
      insideString = false;
      continue;
    }

    if (character === "\\") {
      const next = chars[index + 1];
      if (next !== undefined && validJsonEscapes.has(next)) {
        repaired += character + next;
        index += 1;
      } else {
        // Stray backslash (Windows path, regex) — escape it as a literal.
        repaired += "\\\\";
      }
      continue;
    }

    const code = character.charCodeAt(0);
    if (code >= 0x20) {
      repaired += character;
      continue;
    }

    repaired +=
      character === "\n"
        ? "\\n"
        : character === "\r"
          ? "\\r"
          : character === "\t"
            ? "\\t"
            : `\\u${code.toString(16).padStart(4, "0")}`;
  }

  return repaired;
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
    const normalizedTools = normalizeToolCallBatch(parsed);
    if (normalizedTools) {
      return normalizedTools;
    }

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

function normalizeToolCallBatch(parsed: Record<string, unknown>): unknown {
  if (!Array.isArray(parsed.tool_calls) || parsed.tool_calls.length <= MAX_TOOL_CALLS_PER_RESPONSE) {
    return null;
  }

  const message = readString(parsed.message, "Requesting tools.");
  return {
    ...parsed,
    message: `${message} Truncated to the first ${MAX_TOOL_CALLS_PER_RESPONSE} tool calls.`,
    tool_calls: parsed.tool_calls.slice(0, MAX_TOOL_CALLS_PER_RESPONSE)
  };
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
