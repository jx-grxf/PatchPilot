import { readdir } from "node:fs/promises";
import path from "node:path";
import type { ChatMessage, ModelClient, ModelTelemetry, SubagentRole } from "./types.js";

export type SubagentAdvice = {
  role: SubagentRole;
  message: string;
  telemetry: ModelTelemetry;
};

type AdvisorSpec = {
  role: SubagentRole;
  system: string;
};

const advisorSpecs: AdvisorSpec[] = [
  {
    role: "explorer",
    system: [
      "You are PatchPilot's explorer subagent.",
      "Map likely files, commands, and repo shape for the primary agent.",
      "Stay factual and brief. Do not warn unless a risk blocks progress.",
      "Use at most 4 short bullet lines."
    ].join("\n")
  },
  {
    role: "planner",
    system: [
      "You are PatchPilot's planner subagent.",
      "Give the primary agent a direct tactical path before it edits code.",
      "Focus on likely files, next actions, and fast verification.",
      "Do not claim you inspected files beyond the provided workspace hint.",
      "Use at most 4 short bullet lines."
    ].join("\n")
  },
  {
    role: "reviewer",
    system: [
      "You are PatchPilot's reviewer subagent.",
      "Call out only concrete blockers or easy checks the primary agent should not miss.",
      "Do not produce generic warnings about permissions, overwrites, or tests for simple explicit file edits.",
      "Use at most 3 short bullet lines."
    ].join("\n")
  }
];

export async function runSubagentAdvisors(options: {
  client: ModelClient;
  model: string;
  task: string;
  workspaceRoot: string;
  workspaceSummary?: string;
}): Promise<SubagentAdvice[]> {
  const workspaceHint = await buildWorkspaceHint(options.workspaceRoot);
  const userMessage = [
    `Task: ${options.task}`,
    `Workspace: ${path.basename(options.workspaceRoot) || "workspace"}`,
    "",
    "Workspace hint:",
    workspaceHint,
    options.workspaceSummary ? `\nWorkspace context:\n${options.workspaceSummary}` : ""
  ].join("\n");

  const results = await Promise.allSettled(
    advisorSpecs.map(async (advisor): Promise<SubagentAdvice> => {
      const messages: ChatMessage[] = [
        {
          role: "system",
          content: advisor.system
        },
        {
          role: "user",
          content: userMessage
        }
      ];

      const response = await options.client.chat({
        model: options.model,
        messages,
        formatJson: false
      });

      return {
        role: advisor.role,
        message: clipAdvice(response.content),
        telemetry: response.telemetry
      };
    })
  );

  return results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
}

export function formatSubagentContext(advice: SubagentAdvice[]): string {
  if (advice.length === 0) {
    return "";
  }

  return advice.map((item) => `${item.role} subagent:\n${item.message}`).join("\n\n");
}

async function buildWorkspaceHint(workspaceRoot: string): Promise<string> {
  const entries = await readdir(workspaceRoot, { withFileTypes: true }).catch(() => []);
  const visibleEntries = entries
    .filter((entry) => !entry.name.startsWith(".") || entry.name === ".github")
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, 60)
    .map((entry) => `${entry.isDirectory() ? "dir " : "file"} ${entry.name}`);

  return visibleEntries.length > 0 ? visibleEntries.join("\n") : "No top-level workspace entries could be read.";
}

function clipAdvice(value: string): string {
  const trimmedValue = value.trim();
  if (trimmedValue.length <= 1200) {
    return trimmedValue;
  }

  return `${trimmedValue.slice(0, 1200)}\n...[clipped ${trimmedValue.length - 1200} chars]`;
}
