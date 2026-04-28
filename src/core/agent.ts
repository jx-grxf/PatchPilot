import { formatParseError, parseAgentResponse } from "./json.js";
import path from "node:path";
import { createModelClient } from "./modelClient.js";
import { formatSubagentContext, runSubagentAdvisors } from "./subagents.js";
import type { AgentEvent, ChatMessage, ModelClient, ModelProvider } from "./types.js";
import { WorkspaceTools } from "./workspace.js";

export type AgentRunnerOptions = {
  provider: ModelProvider;
  model: string;
  ollamaUrl: string;
  workspace: string;
  allowWrite: boolean;
  allowShell: boolean;
  maxSteps: number;
  thinkingMode: "fixed" | "adaptive";
  subagents: boolean;
};

export class AgentRunner {
  private readonly client: ModelClient;
  private readonly tools: WorkspaceTools;
  private readonly options: AgentRunnerOptions;

  constructor(options: AgentRunnerOptions) {
    this.options = options;
    this.client = createModelClient({
      provider: options.provider,
      ollamaUrl: options.ollamaUrl,
      workspace: options.workspace
    });
    this.tools = new WorkspaceTools({
      root: options.workspace,
      allowWrite: options.allowWrite,
      allowShell: options.allowShell
    });
  }

  async *run(task: string): AsyncGenerator<AgentEvent> {
    const workspaceSummary = await buildWorkspaceSummary(this.tools.root);
    const maxSteps = resolveMaxSteps(task, this.options.maxSteps, this.options.thinkingMode);
    let subagentContext = "";
    if (this.options.subagents && shouldUseSubagents(task)) {
      yield {
        type: "status",
        message: "consulting planner and reviewer subagents"
      };

      const advice = await runSubagentAdvisors({
        client: this.client,
        model: this.options.model,
        task,
        workspaceRoot: this.tools.root,
        workspaceSummary
      });
      subagentContext = formatSubagentContext(advice);

      for (const item of advice) {
        yield {
          type: "subagent",
          role: item.role,
          message: item.message,
          metrics: item.telemetry
        };
      }
    }

    const messages: ChatMessage[] = [
      {
        role: "system",
        content: buildSystemPrompt(this.tools.root, subagentContext, workspaceSummary)
      },
      {
        role: "user",
        content: task
      }
    ];

    for (let stepIndex = 0; stepIndex < maxSteps; stepIndex += 1) {
      yield {
        type: "status",
        message: `thinking step ${stepIndex + 1}/${maxSteps}${this.options.thinkingMode === "adaptive" ? " adaptive" : ""}`
      };

      const modelResponse = await this.client.chat({
        model: this.options.model,
        messages,
        formatJson: true
      });
      const rawResponse = modelResponse.content;

      yield {
        type: "metrics",
        metrics: modelResponse.telemetry
      };

      let parsedResponse;
      try {
        parsedResponse = parseAgentResponse(rawResponse);
      } catch (error) {
        yield {
          type: "status",
          message: `repairing model protocol: ${formatParseError(error)}`
        };
        messages.push({
          role: "user",
          content:
            "Your previous response was invalid. Return exactly one JSON object, not an array and not Markdown. Use either {\"action\":\"tools\",\"message\":\"...\",\"tool_calls\":[...]} or {\"action\":\"final\",\"message\":\"...\"}."
        });
        continue;
      }

      if (parsedResponse.action === "final") {
        yield {
          type: "final",
          message: parsedResponse.message
        };
        return;
      }

      if (looksLikeClarification(parsedResponse.message)) {
        yield {
          type: "final",
          message: parsedResponse.message
        };
        return;
      }

      yield {
        type: "assistant",
        message: parsedResponse.message
      };

      const toolResults = parsedResponse.tool_calls.every(isReadOnlyToolCall)
        ? await Promise.all(parsedResponse.tool_calls.map((toolCall) => executeToolSafely(this.tools, toolCall)))
        : await executeToolCallsSequentially(this.tools, parsedResponse.tool_calls);

      for (const toolResult of toolResults) {
        yield {
          type: "tool",
          name: toolResult.tool,
          summary: toolResult.summary,
          ok: toolResult.ok
        };
      }

      messages.push({
        role: "assistant",
        content: rawResponse
      });
      messages.push({
        role: "user",
        content: formatToolResultsForPrompt(toolResults)
      });
    }

    yield {
      type: "final",
      message: "Stopped after the configured thinking budget. Increase --steps or use /think adaptive for larger tasks."
    };
  }
}

function shouldUseSubagents(task: string): boolean {
  const normalizedTask = task.toLowerCase();
  if (normalizedTask.trim().split(/\s+/).filter(Boolean).length < 2) {
    return false;
  }

  return /\b(repo|repository|projekt|project|code|file|datei|test|build|fix|debug|implement|refactor|review|analyze|analyse|analysiere|prüf|pruef|bewerte|architektur|erklär|erklaer|such|find|install|commit|diff|patch|src|readme|sprache|programmiersprache|stack|framework|dependencies|abhängigkeiten|abhaengigkeiten|typescript|javascript|node|swift|python|c)\b/.test(
    normalizedTask
  );
}

function buildSystemPrompt(workspaceRoot: string, subagentContext: string, workspaceSummary: string): string {
  return [
    "You are PatchPilot, a local coding agent running inside a terminal TUI.",
    "You help inspect, edit, test, and explain code inside one workspace.",
    "Treat short questions about this project, its language, stack, quality, architecture, dependencies, tests, or files as workspace questions.",
    "For greetings, small talk, or clearly non-workspace chat, answer normally without tool calls.",
    "For ambiguous pronouns like this project or it, assume the current workspace unless the user points elsewhere.",
    "If you ask the user a question, use a final response and do not call tools.",
    "Do not invent repository facts. If you have not read a file, say you have not verified it.",
    "Never pass placeholder examples like relative/path, path/to/file, or <path> as tool arguments.",
    "For repository summaries, inspect README.md, package.json, tests, docs, and top-level source files before answering.",
    "For implementation tasks, first inspect the narrowest relevant files, then edit only what is needed.",
    "When diagnosing a failure, form a concrete hypothesis, gather targeted evidence with tools, then fix the smallest cause.",
    `Workspace label: ${path.basename(workspaceRoot) || "workspace"}`,
    workspaceSummary ? ["", "Workspace context:", workspaceSummary].join("\n") : "",
    subagentContext
      ? [
          "",
          "Advisory subagent context:",
          subagentContext,
          "",
          "Use this guidance as a starting point, but verify with tools before changing code."
        ].join("\n")
      : "",
    "",
    "Return only JSON. Do not use Markdown outside JSON.",
    "Return exactly one JSON object. Never return a JSON array.",
    "",
    "When you need context or want to act, return:",
    "{\"action\":\"tools\",\"message\":\"short reason\",\"tool_calls\":[{\"name\":\"list_files\",\"arguments\":{\"path\":\".\"}}]}",
    "",
    "When the task is complete, return:",
    "{\"action\":\"final\",\"message\":\"short useful answer\"}",
    "",
    "Available tools:",
    "- list_files: {\"path\":\"relative/path\"}",
    "- read_file: {\"path\":\"relative/path\"}",
    "- search_text: {\"query\":\"text to search\"}",
    "- write_file: {\"path\":\"relative/path\",\"content\":\"full file content\"}",
    "- run_shell: {\"command\":\"command to run in the workspace\"}",
    "",
    "Be conservative. Prefer reading before writing. Keep changes focused.",
    "Batch independent read-only tool calls in one response when it helps avoid extra thinking steps.",
    "Prefer parallel read-only context gathering over one file per step.",
    "In final answers, separate verified facts from remaining risks.",
    "Keep tool requests and final answers compact."
  ].join("\n");
}

function looksLikeClarification(message: string): boolean {
  const normalizedMessage = message.trim().toLowerCase();
  return (
    normalizedMessage.endsWith("?") &&
    /\b(what|which|please provide|would you like|do you want|can you specify|welche|was genau|bitte)\b/.test(normalizedMessage)
  );
}

function isReadOnlyToolCall(toolCall: { name: string }): boolean {
  return toolCall.name === "list_files" || toolCall.name === "read_file" || toolCall.name === "search_text";
}

async function executeToolCallsSequentially(tools: WorkspaceTools, toolCalls: Parameters<WorkspaceTools["execute"]>[0][]) {
  const results = [];
  for (const toolCall of toolCalls) {
    results.push(await executeToolSafely(tools, toolCall));
  }

  return results;
}

async function executeToolSafely(tools: WorkspaceTools, toolCall: Parameters<WorkspaceTools["execute"]>[0]) {
  const toolResult = await tools.execute(toolCall).catch((error: unknown) => ({
    ok: false,
    summary: error instanceof Error ? error.message : String(error),
    content: error instanceof Error ? error.stack ?? error.message : String(error)
  }));

  return {
    tool: toolCall.name,
    ok: toolResult.ok,
    summary: toolResult.summary,
    content: toolResult.content
  };
}

function formatToolResultsForPrompt(
  toolResults: Array<{
    tool: string;
    ok: boolean;
    summary: string;
    content: string;
  }>
): string {
  return [
    "Tool results:",
    ...toolResults.map((toolResult, index) =>
      [
        `${index + 1}. ${toolResult.tool} (${toolResult.ok ? "ok" : "error"})`,
        `summary: ${toolResult.summary}`,
        `content: ${clipPromptValue(toolResult.content, toolResult.tool === "read_file" ? 12_000 : 6000)}`
      ].join("\n")
    )
  ].join("\n\n");
}

async function buildWorkspaceSummary(workspaceRoot: string): Promise<string> {
  const [packageJson, tsconfig, readme] = await Promise.all([
    readWorkspaceFile(workspaceRoot, "package.json", 4000),
    readWorkspaceFile(workspaceRoot, "tsconfig.json", 1600),
    readWorkspaceFile(workspaceRoot, "README.md", 3000)
  ]);

  return [
    packageJson ? `package.json:\n${packageJson}` : "",
    tsconfig ? `tsconfig.json:\n${tsconfig}` : "",
    readme ? `README excerpt:\n${readme}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function readWorkspaceFile(workspaceRoot: string, relativePath: string, maxLength: number): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const normalizedRoot = path.resolve(workspaceRoot);
  const normalizedFile = path.resolve(workspaceRoot, relativePath);
  if (!normalizedFile.startsWith(`${normalizedRoot}${path.sep}`)) {
    return "";
  }

  const content = await readFile(normalizedFile, "utf8").catch(() => "");
  return clipPromptValue(content.trim(), maxLength);
}

function resolveMaxSteps(task: string, configuredMaxSteps: number, thinkingMode: AgentRunnerOptions["thinkingMode"]): number {
  if (thinkingMode !== "adaptive") {
    return configuredMaxSteps;
  }

  const words = task.trim().split(/\s+/).filter(Boolean).length;
  const looksComplex = shouldUseSubagents(task) || words > 18 || /\b(implement|refactor|debug|fix|review|architektur|performance|pipeline|context|memory|provider)\b/i.test(task);
  const adaptiveSteps = looksComplex ? Math.max(configuredMaxSteps, 12) : Math.min(configuredMaxSteps, 5);
  return Math.max(3, Math.min(20, adaptiveSteps));
}

function clipPromptValue(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n...[clipped ${value.length - maxLength} chars]`;
}
