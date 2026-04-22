import { formatParseError, parseAgentResponse } from "./json.js";
import { OllamaClient } from "./ollama.js";
import type { AgentEvent, ChatMessage } from "./types.js";
import { WorkspaceTools } from "./workspace.js";

export type AgentRunnerOptions = {
  model: string;
  ollamaUrl: string;
  workspace: string;
  allowWrite: boolean;
  allowShell: boolean;
  maxSteps: number;
};

export class AgentRunner {
  private readonly client: OllamaClient;
  private readonly tools: WorkspaceTools;
  private readonly options: AgentRunnerOptions;

  constructor(options: AgentRunnerOptions) {
    this.options = options;
    this.client = new OllamaClient(options.ollamaUrl);
    this.tools = new WorkspaceTools({
      root: options.workspace,
      allowWrite: options.allowWrite,
      allowShell: options.allowShell
    });
  }

  async *run(task: string): AsyncGenerator<AgentEvent> {
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: buildSystemPrompt(this.tools.root)
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
          type: "error",
          message: `model response did not match protocol: ${formatParseError(error)}`
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

      yield {
        type: "assistant",
        message: parsedResponse.message
      };

      const toolResults = [];
      for (const toolCall of parsedResponse.tool_calls) {
        const toolResult = await this.tools.execute(toolCall).catch((error: unknown) => ({
          ok: false,
          summary: error instanceof Error ? error.message : String(error),
          content: error instanceof Error ? error.stack ?? error.message : String(error)
        }));

        yield {
          type: "tool",
          name: toolCall.name,
          summary: toolResult.summary,
          ok: toolResult.ok
        };

        toolResults.push({
          tool: toolCall.name,
          ok: toolResult.ok,
          summary: toolResult.summary,
          content: toolResult.content
        });
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

function buildSystemPrompt(workspaceRoot: string): string {
  return [
    "You are PatchPilot, a local coding agent running inside a terminal TUI.",
    "You help inspect, edit, test, and explain code inside one workspace.",
    `Workspace root: ${workspaceRoot}`,
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
    "Be conservative. Prefer reading before writing. Keep changes focused."
  ].join("\n");
}
