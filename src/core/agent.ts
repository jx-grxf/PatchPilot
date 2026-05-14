import { formatParseError, parseAgentResponse } from "./json.js";
import path from "node:path";
import { platform, release, type } from "node:os";
import { createModelClient } from "./modelClient.js";
import { resolveProviderReasoning } from "./reasoning.js";
import type { SessionStore } from "./session.js";
import { formatSubagentContext, runSubagentAdvisors } from "./subagents.js";
import type { AgentEvent, AgentToolName, AgentWorkState, ApprovalRequest, ChatMessage, ModelClient, ModelProvider, PermissionDecision, ProviderReasoningEffort, ToolResult } from "./types.js";
import { getToolSpec, WorkspaceTools } from "./workspace.js";

export type AgentRunnerOptions = {
  provider: ModelProvider;
  model: string;
  ollamaUrl: string;
  workspace: string;
  allowWrite: boolean;
  allowShell: boolean;
  maxSteps: number;
  thinkingMode: "fixed" | "adaptive";
  reasoningEffort: ProviderReasoningEffort | "adaptive";
  subagents: boolean;
  signal?: AbortSignal;
  sessionStore?: SessionStore;
  approvalHandler?: (request: ApprovalRequest) => Promise<PermissionDecision>;
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
      allowShell: options.allowShell,
      signal: options.signal,
      approvalHandler: options.approvalHandler
    });
  }

  async *run(task: string): AsyncGenerator<AgentEvent> {
    const runId = createRunId();
    await this.options.sessionStore?.append({
      type: "run.started",
      runId,
      task,
      provider: this.options.provider,
      model: this.options.model,
      startedAt: new Date().toISOString()
    });
    const workspaceSummary = await buildWorkspaceSummary(this.tools.root);
    let maxSteps = resolveMaxSteps(task, this.options.maxSteps, this.options.thinkingMode);
    const reasoningEffort = resolveProviderReasoning({
      provider: this.options.provider,
      model: this.options.model,
      requested: resolveReasoningEffort(task, this.options.reasoningEffort)
    });
    let stepIndex = 0;
    let repairs = 0;
    let subagentContext = "";
    if (this.options.subagents && shouldUseSubagents(task)) {
      yield {
        type: "status",
        message: "consulting planner and reviewer subagents",
        workState: "planning"
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
          metrics: item.telemetry,
          workState: "planning"
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

    while (stepIndex < maxSteps) {
      if (this.options.signal?.aborted) {
        yield {
          type: "final",
          message: "Stopped.",
          workState: "done"
        };
        return;
      }

      yield {
        type: "status",
        message: `thinking step ${stepIndex + 1}/${maxSteps}${this.options.thinkingMode === "adaptive" ? " adaptive" : ""}`,
        workState: stepIndex === 0 ? "planning" : "inspecting"
      };
      await this.options.sessionStore?.append({
        type: "model.request",
        runId,
        workState: stepIndex === 0 ? "planning" : "inspecting",
        provider: this.options.provider,
        model: this.options.model,
        step: stepIndex + 1,
        createdAt: new Date().toISOString()
      });

      const modelResponse = await this.client.chat({
        model: this.options.model,
        messages,
        formatJson: true,
        reasoningEffort,
        signal: this.options.signal
      });
      const rawResponse = modelResponse.content;

      yield {
        type: "metrics",
        metrics: modelResponse.telemetry,
        workState: "planning"
      };

      let parsedResponse;
      try {
        parsedResponse = parseAgentResponse(rawResponse);
      } catch (error) {
        repairs += 1;
        yield {
          type: "status",
          message: `repairing model protocol: ${formatParseError(error)}`,
          workState: "planning"
        };
        messages.push({
          role: "assistant",
          content: rawResponse
        });
        messages.push({
          role: "user",
          content:
            "Your previous response was invalid. Return exactly one JSON object now. Do not explain. Use either {\"action\":\"tools\",\"message\":\"...\",\"tool_calls\":[...]} or {\"action\":\"final\",\"message\":\"...\"}. For simple file edits, call write_file with a workspace-relative path."
        });
        if (repairs >= 3) {
          yield {
            type: "final",
            message: "The model kept returning invalid tool protocol. Try a stronger coding model or switch advisors off for this task.",
            workState: "error"
          };
          await this.options.sessionStore?.append({
            type: "run.failed",
            runId,
            message: "The model kept returning invalid tool protocol.",
            failedAt: new Date().toISOString()
          });
          return;
        }
        continue;
      }

      repairs = 0;
      if (parsedResponse.action === "final") {
        yield {
          type: "final",
          message: parsedResponse.message,
          workState: "done"
        };
        await this.options.sessionStore?.append({
          type: "run.completed",
          runId,
          message: parsedResponse.message,
          completedAt: new Date().toISOString()
        });
        return;
      }

      if (looksLikeClarification(parsedResponse.message)) {
        yield {
          type: "final",
          message: parsedResponse.message,
          workState: "done"
        };
        await this.options.sessionStore?.append({
          type: "run.completed",
          runId,
          message: parsedResponse.message,
          completedAt: new Date().toISOString()
        });
        return;
      }

      yield {
        type: "assistant",
        message: parsedResponse.message,
        workState: "planning"
      };

      const toolCalls = parsedResponse.tool_calls.map(normalizeToolCall);
      const toolCallRecords = toolCalls.map((toolCall) => ({
        id: createToolCallId(toolCall.name),
        call: toolCall,
        workState: workStateForTool(toolCall.name)
      }));
      for (const record of toolCallRecords) {
        await this.options.sessionStore?.append({
          type: "tool.requested",
          runId,
          toolCallId: record.id,
          tool: record.call.name,
          arguments: record.call.arguments,
          workState: record.workState,
          createdAt: new Date().toISOString()
        });
      }
      const toolResults = toolCalls.every(isReadOnlyToolCall)
        ? await Promise.all(toolCallRecords.map((record) => executeToolSafely(this.tools, record.call, record.id)))
        : await executeToolCallsSequentially(this.tools, toolCallRecords);

      for (const toolResult of toolResults) {
        if (toolResult.approval) {
          yield {
            type: "approval",
            request: toolResult.approval.request,
            decision: toolResult.approval.decision,
            workState: "waiting_approval"
          };
          await this.options.sessionStore?.append({
            type: "approval.requested",
            runId,
            request: toolResult.approval.request,
            decision: toolResult.approval.decision,
            createdAt: new Date().toISOString()
          });
        }

        const workState = toolResult.ok ? toolResult.workState : "error";
        yield {
          type: "tool",
          name: toolResult.tool,
          summary: toolResult.summary,
          ok: toolResult.ok,
          workState,
          toolCallId: toolResult.toolCallId,
          category: toolResult.category,
          preview: toolResult.preview,
          metadata: toolResult.metadata
        };
        await this.options.sessionStore?.append({
          type: "tool.completed",
          runId,
          toolCallId: toolResult.toolCallId,
          tool: toolResult.tool,
          ok: toolResult.ok,
          summary: toolResult.summary,
          workState,
          createdAt: new Date().toISOString()
        });
      }

      messages.push({
        role: "assistant",
        content: rawResponse
      });
      messages.push({
        role: "user",
        content: formatToolResultsForPrompt(toolResults)
      });

      stepIndex += 1;
      if (this.options.thinkingMode === "adaptive" && stepIndex >= maxSteps && shouldExtendAdaptiveRun(task, toolResults, maxSteps)) {
        const nextMaxSteps = Math.min(32, maxSteps + 4);
        if (nextMaxSteps > maxSteps) {
          maxSteps = nextMaxSteps;
          yield {
            type: "status",
            message: `expanded adaptive thinking budget to ${maxSteps} steps`,
            workState: "planning"
          };
        }
      }
    }

    yield {
      type: "final",
      message: "Stopped after the thinking budget. The task is not finished yet.",
      workState: "error"
    };
    await this.options.sessionStore?.append({
      type: "run.failed",
      runId,
      message: "Stopped after the thinking budget.",
      failedAt: new Date().toISOString()
    });
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
  const workspaceLabel = path.basename(workspaceRoot) || "workspace";
  return [
    "You are PatchPilot, a local coding agent running inside a terminal TUI.",
    "You help inspect, edit, test, and explain code inside one workspace.",
    `Runtime OS: ${type()} ${release()} (${platform()}). Use OS-appropriate shell commands and paths.`,
    `Workspace root: ${workspaceRoot}`,
    `Workspace label: ${workspaceLabel}`,
    `All tool paths are relative to the workspace root. If the workspace is named "${workspaceLabel}", do not prefix paths with "${workspaceLabel}/". Use "." for the workspace root.`,
    "Treat short questions about this project, its language, stack, quality, architecture, dependencies, tests, or files as workspace questions.",
    "For greetings, small talk, or clearly non-workspace chat, answer normally without tool calls.",
    "For ambiguous pronouns like this project or it, assume the current workspace unless the user points elsewhere.",
    "If you ask the user a question, use a final response and do not call tools.",
    "Do not invent repository facts. If you have not read a file, say you have not verified it.",
    "Never pass placeholder examples like relative/path, path/to/file, or <path> as tool arguments.",
    "For repository summaries, inspect README.md, package.json, tests, docs, and top-level source files before answering.",
    "For implementation tasks, first inspect the narrowest relevant files, then edit only what is needed.",
    "When diagnosing a failure, form a concrete hypothesis, gather targeted evidence with tools, then fix the smallest cause.",
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
    "- list_files: {\"path\":\".\"}",
    "- read_file: {\"path\":\"src/index.ts\"}",
    "- read_range: {\"path\":\"src/index.ts\",\"start\":1,\"end\":80}",
    "- file_info: {\"path\":\"src/index.ts\"}",
    "- search_text: {\"query\":\"functionName\"}",
    "- inspect_document: {\"path\":\"docs/spec.pdf\"} for pdf, docx, and text/code files",
    "- git_status: {} for current branch and dirty files",
    "- git_diff: {\"path\":\"src/index.ts\"} or {} for all current changes",
    "- list_changed_files: {}",
    "- list_scripts: {} for package manager scripts from package.json",
    "- write_file: {\"path\":\"test2/test.txt\",\"content\":\"full file content\"}",
    "- apply_patch: {\"patch\":\"unified git patch\"}",
    "- run_script: {\"script\":\"test\"}",
    "- run_tests: {}",
    "- run_shell: {\"command\":\"single simple command to run in the workspace\"}",
    "",
    "Act like a coding agent. For simple create/edit/run requests, use tools directly instead of over-warning.",
    "Do not call search_text with an empty query. Use list_files {\"path\":\".\"} to inspect a directory.",
    "Prefer reading before risky edits; for explicit simple writes, write the requested file.",
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
  return getToolSpec(toolCall.name as AgentToolName)?.sideEffects === "none";
}

function normalizeToolCall(toolCall: Parameters<WorkspaceTools["execute"]>[0]): Parameters<WorkspaceTools["execute"]>[0] {
  if (toolCall.name === "search_text") {
    const query = typeof toolCall.arguments.query === "string" ? toolCall.arguments.query.trim() : "";
    if (!query) {
      return {
        name: "list_files",
        arguments: {
          path: "."
        }
      };
    }
  }

  return toolCall;
}

async function executeToolCallsSequentially(
  tools: WorkspaceTools,
  toolCalls: Array<{
    id: string;
    call: Parameters<WorkspaceTools["execute"]>[0];
    workState: AgentWorkState;
  }>
) {
  const results = [];
  for (const toolCall of toolCalls) {
    results.push(await executeToolSafely(tools, toolCall.call, toolCall.id));
  }

  return results;
}

async function executeToolSafely(tools: WorkspaceTools, toolCall: Parameters<WorkspaceTools["execute"]>[0], toolCallId: string) {
  const toolResult: ToolResult = await tools.execute(toolCall).catch((error: unknown) => ({
    ok: false,
    summary: error instanceof Error ? error.message : String(error),
    content: error instanceof Error ? error.stack ?? error.message : String(error),
    tool: toolCall.name,
    category: getToolSpec(toolCall.name).category
  }));

  return {
    tool: toolCall.name,
    ok: toolResult.ok,
    summary: toolResult.summary,
    content: toolResult.content,
    toolCallId,
    category: toolResult.category ?? getToolSpec(toolCall.name).category,
    preview: toolResult.preview,
    approval: toolResult.approval,
    metadata: toolResult.metadata,
    workState: workStateForTool(toolCall.name)
  };
}

function formatToolResultsForPrompt(
  toolResults: Array<{
    tool: AgentToolName;
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

function workStateForTool(tool: AgentToolName): AgentWorkState {
  const category = getToolSpec(tool).category;
  if (category === "write") {
    return "editing";
  }

  if (category === "shell" || category === "test") {
    return "verifying";
  }

  if (category === "read" || category === "document" || category === "search" || category === "git") {
    return "reading";
  }

  return "inspecting";
}

function createRunId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createToolCallId(tool: AgentToolName): string {
  return `${tool}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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

function shouldExtendAdaptiveRun(
  task: string,
  toolResults: Array<{
    ok: boolean;
    summary: string;
  }>,
  currentMaxSteps: number
): boolean {
  if (currentMaxSteps >= 32) {
    return false;
  }

  const hasUsefulProgress = toolResults.some((result) => result.ok);
  const hasRecoverableFailure = toolResults.some((result) => !result.ok && /not found|missing|requires|denied|failed|unreadable/i.test(result.summary));
  return hasUsefulProgress || hasRecoverableFailure || shouldUseSubagents(task);
}

function resolveReasoningEffort(task: string, effort: AgentRunnerOptions["reasoningEffort"]): ProviderReasoningEffort {
  if (effort !== "adaptive") {
    return effort;
  }

  const wordCount = task.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount > 40 || /\b(large|complex|refactor|architecture|architektur|debug|provider|pipeline|performance|security|release)\b/i.test(task)) {
    return "high";
  }

  if (wordCount < 8 && !shouldUseSubagents(task)) {
    return "low";
  }

  return "medium";
}

function clipPromptValue(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n...[clipped ${value.length - maxLength} chars]`;
}
