import { formatParseError, parseAgentResponse } from "./json.js";
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
      ollamaUrl: options.ollamaUrl
    });
    this.tools = new WorkspaceTools({
      root: options.workspace,
      allowWrite: options.allowWrite,
      allowShell: options.allowShell
    });
  }

  async *run(task: string): AsyncGenerator<AgentEvent> {
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
        workspaceRoot: this.tools.root
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
        content: buildSystemPrompt(this.tools.root, subagentContext)
      },
      {
        role: "user",
        content: task
      }
    ];

    for (let stepIndex = 0; stepIndex < this.options.maxSteps; stepIndex += 1) {
      yield {
        type: "status",
        message: `thinking step ${stepIndex + 1}/${this.options.maxSteps}`
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
        content: `Tool results:\n${JSON.stringify(toolResults, null, 2)}`
      });
    }

    yield {
      type: "final",
      message: "Stopped after the configured max step count. Increase --steps if the task needs more context."
    };
  }
}

function shouldUseSubagents(task: string): boolean {
  const normalizedTask = task.toLowerCase();
  if (normalizedTask.trim().split(/\s+/).filter(Boolean).length < 2) {
    return false;
  }

  return /\b(repo|repository|code|file|test|build|fix|debug|implement|refactor|review|analyze|analyse|analysiere|erklär|erklaer|such|find|install|commit|diff|patch|src|readme|typescript|swift|c)\b/.test(
    normalizedTask
  );
}

function buildSystemPrompt(workspaceRoot: string, subagentContext: string): string {
  return [
    "You are PatchPilot, a local coding agent running inside a terminal TUI.",
    "You help inspect, edit, test, and explain code inside one workspace.",
    "Only use tools for explicit coding, repository, file, test, shell, or debugging tasks.",
    "For greetings, small talk, or ambiguous requests, return a final clarification question without tool calls.",
    "If you ask the user a question, use a final response and do not call tools.",
    "Do not invent repository facts. If you have not read a file, say you have not verified it.",
    "Never pass placeholder examples like relative/path, path/to/file, or <path> as tool arguments.",
    "For repository summaries, inspect README.md, package.json, tests, docs, and top-level source files before answering.",
    "For implementation tasks, first inspect the narrowest relevant files, then edit only what is needed.",
    "When diagnosing a failure, form a concrete hypothesis, gather targeted evidence with tools, then fix the smallest cause.",
    `Workspace root: ${workspaceRoot}`,
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
