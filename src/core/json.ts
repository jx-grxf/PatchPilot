import { z } from "zod";
import type { AgentResponse } from "./types.js";

const toolNameSchema = z.enum([
  "list_files",
  "read_file",
  "search_text",
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
  const parsed = JSON.parse(extractJson(rawContent));
  return agentResponseSchema.parse(parsed);
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
