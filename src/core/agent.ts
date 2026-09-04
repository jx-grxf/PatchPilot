import { formatParseError, parseAgentResponse } from "./json.js";
import path from "node:path";
import { platform, release, type } from "node:os";
import { createModelClient } from "./modelClient.js";
import type { SessionStore } from "./session.js";
import { formatSubagentContext, runSubagentAdvisors } from "./subagents.js";
import { MAX_TOOL_CALLS_PER_RESPONSE, type AgentEvent, type AgentTodoItem, type AgentToolName, type AgentWorkState, type ApprovalRequest, type ChatMessage, type ModelChatResult, type ModelClient, type ModelProvider, type PermissionDecision, type ThinkingSetting, type ProviderTool, type RawToolCall, type AgentToolCall, type ToolCategory, type ToolResult } from "./types.js";
import { StreamTimer } from "./stream.js";
import { probeModelCapabilities } from "./capability.js";
import { measureContext, pruneToolResults } from "./contextWindow.js";
import {
  extractFencedToolCalls,
  extractStringifiedToolCalls,
  looksLikePermissionRequest,
  repairToolCall,
  ToolCallLoopBreaker
} from "./toolRepair.js";
import { toolsForMode, toProviderTools, toWorkspaceCall, type ToolMode } from "./toolSchema.js";
import { estimateTokens } from "./tokenAccounting.js";
import { getToolSpec, WorkspaceTools } from "./workspace.js";

export type AgentRunnerOptions = {
  provider: ModelProvider;
  model: string;
  ollamaUrl: string;
  workspace: string;
  mode?: "plan" | "build" | "bypass";
  allowWrite: boolean;
  allowShell: boolean;
  maxSteps: number;
  thinkingMode: "fixed" | "adaptive";
  thinking: ThinkingSetting;
  subagents: boolean;
  resumeContext?: string;
  allowExternalFileAnalysis?: boolean;
  allowShellMetacharacters?: boolean;
  memoryEnabled?: boolean;
  ultramaxx?: boolean;
  signal?: AbortSignal;
  shouldStopAfterStep?: () => boolean;
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
    const documentAnalyzer = this.client.analyzeFile && (this.client.supportsFileAnalysis?.() ?? true)
      ? async (request: { path: string; prompt: string; signal?: AbortSignal }) => {
          const result = await this.client.analyzeFile?.({
            model: options.model,
            path: request.path,
            prompt: request.prompt,
            signal: request.signal
          });
          return result?.content ?? "";
        }
      : undefined;
    this.tools = new WorkspaceTools({
      root: options.workspace,
      allowWrite: options.allowWrite,
      allowShell: options.allowShell,
      allowShellMetacharacters: options.allowShellMetacharacters,
      allowExternalFileAnalysis: options.allowExternalFileAnalysis,
      documentAnalyzer,
      memoryEnabled: options.memoryEnabled,
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
    const ultramaxx = Boolean(this.options.ultramaxx);
    let maxSteps = resolveMaxSteps(task, this.options.maxSteps, this.options.thinkingMode, ultramaxx);
    const thinking = this.options.thinking;

    // Ask the model once whether it can drive native tool calls. Advertising
    // tools to a model that ignores them is worse than not advertising: it
    // answers in prose, the loop sees no calls, and the run stalls looking
    // like a refusal.
    const capabilities = await probeModelCapabilities({
      client: this.client,
      provider: this.options.provider,
      model: this.options.model,
      signal: this.options.signal
    });
    const mode: ToolMode = this.options.mode ?? (this.options.allowWrite || this.options.allowShell ? "build" : "plan");
    const availableTools = toolsForMode(mode, { subagents: Boolean(this.options.subagents) });
    const providerTools = capabilities.nativeToolCalls ? toProviderTools(availableTools) : undefined;
    const loopBreaker = new ToolCallLoopBreaker();
    // The window the runtime actually loaded, which is not the num_ctx the
    // harness sends and not necessarily what the model advertises.
    const contextLimitTokens = await this.resolveContextLimit();
    let sawPermissionRequest = false;

    yield {
      type: "status",
      message: capabilities.nativeToolCalls
        ? `native tool calling: ${availableTools.length} tools in ${mode} mode`
        : `tool protocol fallback: ${capabilities.detail}`,
      workState: "planning"
    };
    let stepIndex = 0;
    let repairs = 0;
    let malformedResponses = 0;
    let lastReadFilePath = "";
    let subagentContext = "";
    let todos: AgentTodoItem[] = [];
    const expectsTodos = shouldExpectTodos(task, ultramaxx);
    let didNudgeForTodos = false;
    let didPushBackForTodos = false;
    let didPushBackForVerification = false;
    let hadWrite = false;
    let verifiedSinceLastWrite = true;
    let emptyToolBatches = 0;
    const recentToolSignatures: string[] = [];

    if (ultramaxx) {
      yield {
        type: "status",
        message: "ultramaxx backend escalation active: xhigh reasoning, mandatory todos, expanded verification guard",
        workState: "planning"
      };
    }
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
        content: buildSystemPrompt(this.tools.root, subagentContext, workspaceSummary, this.options.resumeContext ?? "", {
          provider: this.options.provider,
          mode: this.options.mode ?? (this.options.allowWrite || this.options.allowShell ? "bypass" : "plan"),
          allowWrite: this.options.allowWrite,
          allowShell: this.options.allowShell,
          hasApprovalHandler: Boolean(this.options.approvalHandler)
        }, {
          allowExternalFileAnalysis: Boolean(this.options.allowExternalFileAnalysis),
          memoryEnabled: Boolean(this.options.memoryEnabled),
          allowShellMetacharacters: Boolean(this.options.allowShellMetacharacters),
          ultramaxx,
          expectsTodos,
          nativeTools: capabilities.nativeToolCalls
        })
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

      const requestWorkState = stepIndex === 0 ? "planning" : "inspecting";
      yield {
        type: "status",
        message: `thinking step ${stepIndex + 1}/${maxSteps}${this.options.thinkingMode === "adaptive" ? " adaptive" : ""}`,
        workState: requestWorkState
      };
      await this.options.sessionStore?.append({
        type: "model.request",
        runId,
        workState: requestWorkState,
        provider: this.options.provider,
        model: this.options.model,
        step: stepIndex + 1,
        createdAt: new Date().toISOString()
      });

      let modelResponse;
      try {
        const chatAttempts = this.chatWithRetry({
          model: this.options.model,
          messages,
          thinking,
          tools: providerTools,
          requestWorkState,
          attemptLabel: `step ${stepIndex + 1}`
        });
        for (;;) {
          const nextAttempt = await chatAttempts.next();
          if (nextAttempt.done) {
            modelResponse = nextAttempt.value;
            break;
          }
          yield nextAttempt.value;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.options.sessionStore?.append({
          type: "run.failed",
          runId,
          message,
          failedAt: new Date().toISOString()
        });
        throw error;
      }
      const rawResponse = modelResponse.content;

      yield {
        type: "metrics",
        metrics: modelResponse.telemetry,
        workState: requestWorkState
      };
      if (modelResponse.warning) {
        yield {
          type: "status",
          message: modelResponse.warning,
          workState: requestWorkState
        };
      }

      let parsedResponse;

      // Native tool calls, when the runtime produced any, bypass the envelope
      // entirely. L2 also covers the measured case where a model prints a
      // well-formed call inside a fence and makes no real call at all.
      const nativeCalls =
        modelResponse.toolCalls && modelResponse.toolCalls.length > 0
          ? modelResponse.toolCalls
          : providerTools
            ? // L0 first: a serving-layer parser failure puts a correct call
              // into content as a string, which looks exactly like a refusal.
              firstNonEmpty(extractStringifiedToolCalls(rawResponse), extractFencedToolCalls(rawResponse))
            : [];

      if (nativeCalls.length > 0) {
        const resolved = this.resolveNativeToolCalls(nativeCalls, loopBreaker);
        if (resolved.problems.length > 0 && resolved.toolCalls.length === 0) {
          // Every call was unusable: hand the guidance back and let the model
          // correct within the same turn rather than ending the run.
          repairs += 1;
          for (const problem of resolved.problems) {
            yield { type: "status", message: problem, workState: "planning" };
          }
          messages.push({ role: "assistant", content: clipPromptValue(rawResponse, 2000) });
          messages.push({ role: "user", content: resolved.problems.join("\n") });
          if (repairs >= 3) {
            yield {
              type: "final",
              message: `The model could not produce a usable tool call: ${resolved.problems[0] ?? "unknown"}`,
              workState: "error"
            };
            return;
          }
          continue;
        }

        for (const note of resolved.notes) {
          yield { type: "status", message: note, workState: "planning" };
        }

        parsedResponse = {
          action: "tools" as const,
          message: rawResponse.trim() || "working",
          tool_calls: resolved.toolCalls
        };
      } else if (providerTools) {
        // Capable model, no calls, no fence: it answered. Guard against a
        // permission request made despite an explicit act-don't-ask prompt.
        if (!sawPermissionRequest && looksLikePermissionRequest(rawResponse)) {
          sawPermissionRequest = true;
          yield {
            type: "status",
            message: "model asked for permission it already has; re-prompting to act",
            workState: "planning"
          };
          messages.push({ role: "assistant", content: clipPromptValue(rawResponse, 2000) });
          messages.push({
            role: "user",
            content:
              "You already have permission. Do not ask — carry out the work now using the tools, and report what you changed."
          });
          continue;
        }

        // A model coming off the legacy protocol sometimes narrates an
        // envelope as prose. Presenting that raw as the answer looks like a
        // crash, so it is stripped down to its message.
        parsedResponse = { action: "final" as const, message: readFinalMessage(rawResponse) };
      } else {
      try {
        parsedResponse = parseAgentResponse(rawResponse);
      } catch (error) {
        const recoveredResponse = recoverMalformedToolResponse(rawResponse);
        if (recoveredResponse) {
          parsedResponse = recoveredResponse;
          const recoveredPath = recoveredResponse.tool_calls[0]?.arguments.path ?? "workspace file";
          yield {
            type: "status",
            message: `recovered malformed model protocol as ${recoveredResponse.tool_calls[0]?.name ?? "tool"} for ${recoveredPath}`,
            workState: "planning"
          };
        } else {
          repairs += 1;
          malformedResponses += 1;
          yield {
            type: "status",
            message: `repairing model protocol: ${formatParseError(error)}`,
            workState: "planning"
          };
          messages.push({
            role: "assistant",
            content: clipPromptValue(rawResponse, 2000)
          });
          messages.push({
            role: "user",
            content:
              "Your previous response was invalid. Return exactly one JSON object now. Do not explain. Use either {\"action\":\"tools\",\"message\":\"...\",\"tool_calls\":[...]} or {\"action\":\"final\",\"message\":\"...\"}. For simple file edits, call write_file with a workspace-relative path."
          });
          if (repairs >= 3 || malformedResponses >= 3) {
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
      }
      }

      repairs = 0;
      if (parsedResponse.action === "final") {
        if (expectsTodos && hasOpenTodos(todos) && !didPushBackForTodos) {
          didPushBackForTodos = true;
          messages.push({
            role: "assistant",
            content: JSON.stringify(parsedResponse)
          });
          messages.push({
            role: "user",
            content: "Your todo list still has pending or in_progress items. Update the todo list first, then return final when the work is genuinely complete."
          });
          stepIndex += 1;
          continue;
        }

        if (ultramaxx && hadWrite && !verifiedSinceLastWrite && !didPushBackForVerification) {
          didPushBackForVerification = true;
          messages.push({
            role: "assistant",
            content: JSON.stringify(parsedResponse)
          });
          messages.push({
            role: "user",
            content: "You changed files in ultramaxx mode without verification since the last write. Run tests, a script, shell verification, or git_diff before final."
          });
          stepIndex += 1;
          continue;
        }

        if (expectsTodos && isTodoOnlyFinalResponse(parsedResponse.message)) {
          messages.push({
            role: "assistant",
            content: JSON.stringify(parsedResponse)
          });
          messages.push({
            role: "user",
            content: "Your final answer was invalid because it only reported todo/status progress or deferred to an earlier step. Return a real final answer now with the actual findings, changes made, verification run, and any remaining risks. Do not mention update_todo as the outcome."
          });
          stepIndex += 1;
          continue;
        }

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

      const toolCalls = parsedResponse.tool_calls.slice(0, MAX_TOOL_CALLS_PER_RESPONSE).map(normalizeToolCall);
      if (toolCalls.length === 0 && looksLikeClarification(parsedResponse.message)) {
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
      if (toolCalls.length === 0) {
        emptyToolBatches += 1;
        messages.push({
          role: "assistant",
          content: JSON.stringify(parsedResponse)
        });

        if (shouldStopAfterEmptyToolBatches(emptyToolBatches)) {
          yield {
            type: "final",
            message: "Stopped because the model returned a tool action without tool calls twice. Retry the task or switch models.",
            workState: "error"
          };
          await this.options.sessionStore?.append({
            type: "run.failed",
            runId,
            message: "Model returned empty tool batches repeatedly.",
            failedAt: new Date().toISOString()
          });
          return;
        }

        messages.push({
          role: "user",
          content: "You returned action:\"tools\" without any tool_calls. Either call one valid tool now or return action:\"final\" with the completed answer."
        });
        stepIndex += 1;
        continue;
      }
      emptyToolBatches = 0;

      const { todoCalls, workspaceCalls } = splitTodoToolCalls(toolCalls);
      if (expectsTodos && todos.length === 0 && workspaceCalls.length > 0 && !didNudgeForTodos) {
        didNudgeForTodos = true;
        messages.push({
          role: "assistant",
          content: JSON.stringify({
            action: "tools",
            message: parsedResponse.message,
            tool_calls: toolCalls
          })
        });
        messages.push({
          role: "user",
          content: "This task has multiple steps. Call update_todo with a concrete 2-6 item plan first, then continue with the needed tools."
        });
        stepIndex += 1;
        continue;
      }

      const repeatedCall = findRepeatedToolCall(workspaceCalls, recentToolSignatures);
      if (repeatedCall) {
        messages.push({
          role: "assistant",
          content: JSON.stringify({
            action: "tools",
            message: parsedResponse.message,
            tool_calls: toolCalls
          })
        });
        messages.push({
          role: "user",
          content: `You already ran ${repeatedCall.name} with the same arguments repeatedly. Act on the previous result or return final instead of repeating it.`
        });
        stepIndex += 1;
        continue;
      }

      const todoResults: Awaited<ReturnType<typeof executeToolSafely>>[] = [];
      for (const todoCall of todoCalls) {
        todos = normalizeTodoItems(todoCall.arguments, todos);
        const summary = summarizeTodos(todos);
        yield {
          type: "todo",
          items: todos,
          summary,
          workState: "planning"
        };
        await this.options.sessionStore?.append({
          type: "todo.updated",
          runId,
          items: todos,
          summary,
          createdAt: new Date().toISOString()
        });
        todoResults.push({
          tool: "update_todo",
          ok: true,
          summary,
          content: JSON.stringify({ items: todos }),
          toolCallId: createToolCallId("update_todo"),
          category: "state",
          preview: undefined,
          approval: undefined,
          metadata: {
            items: todos
          },
          workState: "planning"
        });
      }

      const toolCallRecords = workspaceCalls.map((toolCall) => ({
        id: createToolCallId(toolCall.name),
        call: toolCall,
        workState: workStateForTool(toolCall.name)
      }));
      const workspaceCallById = new Map(toolCallRecords.map((record) => [record.id, record.call]));
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
      const toolResults = [
        ...todoResults,
        ...(await executeToolCallsWithReadParallelism(this.tools, toolCallRecords))
      ];

      for (const toolResult of toolResults) {
        // L5 counts only failures: a call that worked should never be refused
        // later just because it was repeated.
        if (!toolResult.ok) {
          const failedCall = workspaceCallById.get(toolResult.toolCallId);
          if (failedCall) {
            loopBreaker.recordFailure(failedCall.name as never, failedCall.arguments);
          }
        }

        if (isWriteToolResult(toolResult)) {
          hadWrite = true;
          verifiedSinceLastWrite = false;
        } else if (isVerificationToolResult(toolResult)) {
          verifiedSinceLastWrite = true;
        }

        const sourceCall = workspaceCallById.get(toolResult.toolCallId);
        if (toolResult.ok && sourceCall?.name === "read_file") {
          const readPath = readToolString(sourceCall.arguments.path);
          if (readPath) {
            lastReadFilePath = readPath;
          }
        }

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
          content: toolResult.ok ? undefined : toolResult.content,
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
        content: JSON.stringify({
          action: "tools",
          message: parsedResponse.message,
          tool_calls: toolCalls
        })
      });
      messages.push({
        role: "user",
        content: formatToolResultsForPrompt(toolResults)
      });
      if (contextLimitTokens) {
        const usage = measureContext(messages, {
          limitTokens: contextLimitTokens,
          reserveTokens: Math.min(2048, Math.floor(contextLimitTokens / 8))
        });
        yield {
          type: "context",
          usedTokens: usage.usedTokens,
          limitTokens: usage.limitTokens,
          ratio: usage.ratio,
          pressure: usage.pressure,
          workState: "verifying"
        };
      }

      // Prune old tool output before anything else: it is what actually
      // floods a small window, and it is the cheapest thing to discard.
      const pruned = pruneToolResults(messages);
      if (pruned.prunedCount > 0) {
        messages.length = 0;
        messages.push(...pruned.messages);
        yield {
          type: "status",
          message: `pruned ${pruned.prunedCount} older tool result${pruned.prunedCount === 1 ? "" : "s"} (~${pruned.prunedTokens} tokens)`,
          workState: "verifying"
        };
      }

      stepIndex += 1;
      if (this.options.shouldStopAfterStep?.()) {
        yield {
          type: "final",
          message: "Stopped after the current step.",
          workState: "done"
        };
        await this.options.sessionStore?.append({
          type: "run.failed",
          runId,
          message: "Stopped after the current step.",
          failedAt: new Date().toISOString()
        });
        return;
      }
      if (this.options.thinkingMode === "adaptive" && stepIndex >= maxSteps && shouldExtendAdaptiveRun(task, toolResults, maxSteps, ultramaxx ? 60 : 32)) {
        const nextMaxSteps = Math.min(ultramaxx ? 60 : 32, maxSteps + 4);
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

  /**
   * Asks the runtime what window the model is really loaded with. Returns null
   * when the runtime does not say, in which case no meter is shown — a wrong
   * number is worse than none.
   */
  private async resolveContextLimit(): Promise<number | null> {
    try {
      const descriptors = await this.client.listModelDescriptors?.();
      const match = descriptors?.find((descriptor) => descriptor.id === this.options.model);
      if (match?.capacity && Number.isFinite(match.capacity)) {
        return match.capacity;
      }
    } catch {
      // Discovery is best-effort; a run must not fail because of a meter.
    }

    return null;
  }

  /**
   * Runs the repair ladder over one batch of native calls. Calls that survive
   * are executed; calls that do not come back as guidance the model can act on
   * in the same turn. A batch is never abandoned because one call was bad.
   */
  private resolveNativeToolCalls(
    rawCalls: RawToolCall[],
    loopBreaker: ToolCallLoopBreaker
  ): { toolCalls: AgentToolCall[]; problems: string[]; notes: string[] } {
    const toolCalls: AgentToolCall[] = [];
    const problems: string[] = [];
    const notes: string[] = [];

    for (const rawCall of rawCalls.slice(0, MAX_TOOL_CALLS_PER_RESPONSE)) {
      const repaired = repairToolCall(rawCall);
      if ("message" in repaired) {
        problems.push(repaired.message);
        continue;
      }

      const looping = loopBreaker.check(repaired.name, repaired.arguments);
      if (looping) {
        problems.push(looping.message);
        continue;
      }

      if (repaired.repairs.length > 0) {
        notes.push(`repaired ${repaired.name} call: ${repaired.repairs.join(", ")}`);
      }

      toolCalls.push(toWorkspaceCall(repaired.name, repaired.arguments));
    }

    return { toolCalls, problems, notes };
  }

  private async *chatWithRetry(options: {
    model: string;
    messages: ChatMessage[];
    thinking: ThinkingSetting | undefined;
    tools?: ProviderTool[];
    requestWorkState: AgentWorkState;
    attemptLabel: string;
  }): AsyncGenerator<AgentEvent, ModelChatResult> {
    const maxAttempts = 3;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const attempt = this.streamChat(options);
        for (;;) {
          const next = await attempt.next();
          if (next.done) {
            return next.value;
          }
          yield next.value;
        }
      } catch (error) {
        lastError = error;
        if (this.options.signal?.aborted || attempt >= maxAttempts || !isRetryableModelError(error)) {
          break;
        }

        yield {
          type: "status",
          message: `provider retry ${attempt + 1}/${maxAttempts} after ${formatRetryableModelError(error)}`,
          workState: options.requestWorkState
        };
        await delay(modelRetryDelayMs(attempt));
      }
    }

    throw lastError;
  }

  /**
   * Bridges the provider's push-based delta callback into this pull-based
   * generator. Progress events are throttled and coalesced: one per token
   * would flood the transcript and cost more to render than to generate.
   */
  private async *streamChat(options: {
    model: string;
    messages: ChatMessage[];
    thinking: ThinkingSetting | undefined;
    tools?: ProviderTool[];
    requestWorkState: AgentWorkState;
  }): AsyncGenerator<AgentEvent, ModelChatResult> {
    const timer = new StreamTimer();
    let pendingThinking = "";
    let tokens = 0;
    let wake: (() => void) | null = null;
    let finished = false;

    const nudge = (): void => {
      wake?.();
      wake = null;
    };

    const chat = this.client
      .chat({
        model: options.model,
        messages: options.messages,
        // The envelope needs a JSON response; native tool calling does not,
        // and asking for both makes a model describe a call instead of making
        // one.
        formatJson: !options.tools,
        tools: options.tools,
        thinking: options.thinking,
        signal: this.options.signal,
        onDelta: (delta) => {
          if (delta.content) {
            timer.markFirstToken();
            tokens += estimateTokens(delta.content);
          }
          if (delta.thinking) {
            timer.markFirstToken();
            pendingThinking += delta.thinking;
          }
          nudge();
        }
      })
      .finally(() => {
        finished = true;
        nudge();
      });

    // Surface progress on a fixed cadence rather than per delta, so a fast
    // model and a slow one produce the same update rate.
    while (!finished) {
      await Promise.race([
        chat.catch(() => undefined),
        new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, streamProgressIntervalMs).unref?.();
        })
      ]);

      if (finished) {
        break;
      }

      // Reasoning arrives token by token. Flushing on every tick would emit
      // one transcript line per word, so it is buffered into readable blocks.
      if (pendingThinking.length >= thinkingFlushChars) {
        const boundary = lastSentenceBoundary(pendingThinking);
        yield {
          type: "thinking",
          message: pendingThinking.slice(0, boundary).trim(),
          workState: options.requestWorkState
        };
        pendingThinking = pendingThinking.slice(boundary);
      }

      const generating = timer.timeToFirstTokenMs !== null;
      yield {
        type: "stream",
        phase: generating ? "generating" : "prompt",
        elapsedMs: timer.elapsedMs,
        tokens,
        tokensPerSecond: generating && timer.generationMs > 0 ? tokens / (timer.generationMs / 1000) : null,
        workState: options.requestWorkState
      };
    }

    if (pendingThinking.trim()) {
      yield {
        type: "thinking",
        message: pendingThinking.trim(),
        workState: options.requestWorkState
      };
    }

    return await chat;
  }
}

function firstNonEmpty<T>(...candidates: T[][]): T[] {
  return candidates.find((candidate) => candidate.length > 0) ?? [];
}

/** How often streaming progress is reported, in milliseconds. */
const streamProgressIntervalMs = 120;

/** Reasoning is buffered to at least this many characters before it is shown. */
const thinkingFlushChars = 280;

/** Prefers to break reasoning at a sentence end rather than mid-word. */
function lastSentenceBoundary(value: string): number {
  const match = value.slice(0, thinkingFlushChars * 2).match(/^[\s\S]*[.!?\n]\s/);
  return match ? match[0].length : value.length;
}

export function recoverMalformedToolResponse(rawContent: string): { action: "tools"; message: string; tool_calls: Array<{ name: "write_file"; arguments: { path: string; content: string } }> } | null {
  const targetPath = readWriteFileToolPath(rawContent);
  if (!targetPath) {
    return null;
  }

  if (!/"tool_calls"\s*:/.test(rawContent) || !/"name"\s*:\s*"write_file"/.test(rawContent)) {
    return null;
  }

  const htmlContent =
    readFirstRegexGroup(rawContent, /(```(?:html)?\s*)([\s\S]*?<\/html>)\s*```/i, 2) ??
    readFirstRegexGroup(rawContent, /(<!doctype html[\s\S]*?<\/html>)/i) ??
    readFirstRegexGroup(rawContent, /(<html[\s\S]*?<\/html>)/i);

  if (!htmlContent) {
    return null;
  }

  return {
    action: "tools",
    message: "Recovered malformed HTML tool response.",
    tool_calls: [
      {
        name: "write_file",
        arguments: {
          path: targetPath,
          content: htmlContent.trim()
        }
      }
    ]
  };
}

function readFirstRegexGroup(value: string, pattern: RegExp, groupIndex = 1): string | null {
  const match = value.match(pattern);
  const group = match?.[groupIndex];
  return typeof group === "string" && group.trim() ? group : null;
}

function readWriteFileToolPath(rawContent: string): string | null {
  return readFirstRegexGroup(
    rawContent,
    /"tool_calls"\s*:\s*\[[\s\S]*?"name"\s*:\s*"write_file"[\s\S]*?"arguments"\s*:\s*\{[\s\S]*?"path"\s*:\s*"([^"]+)"/
  );
}

function readToolString(value: unknown): string {
  return typeof value === "string" ? value : "";
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

export function shouldExpectTodos(task: string, ultramaxx = false): boolean {
  if (ultramaxx) {
    return true;
  }

  const words = task.trim().split(/\s+/).filter(Boolean).length;
  return (
    words > 8 &&
    /\b(implement|refactor|fix|debug|add|build|migrate|rewrite|hardening|verify|test|release|umsetz|reparier|baue|füge|fuege|prüf|pruef)\b/i.test(task)
  );
}

export function isTodoOnlyFinalResponse(message: string): boolean {
  const normalized = message.trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized) {
    return true;
  }

  const mentionsTodoState = /\b(update_todo|todo(?:s|-list| list|-liste| liste)?|checklist|aufgabenliste)\b/i.test(normalized);
  const mentionsProgressOnly = /\b(updated|aktualisiert|completed|complete|done|erledigt|abgeschlossen|marked|gepflegt)\b/i.test(normalized);
  const defersToEarlierStep =
    /\b(previous|prior|earlier|above|already|before)\b/i.test(normalized) ||
    /\b(vorherig|vorherigen|vorher|oben|zuvor|bereits|letzten schritt)\b/i.test(normalized);
  const mentionsDeferredAnswer = /\b(summary|overview|answer|result|findings|zusammenfassung|überblick|ueberblick|antwort|ergebnis)\b/i.test(normalized);
  const hasConcreteOutcome = /\b(fixed|implemented|changed|added|removed|verified|tested|ran|created|gefixt|implementiert|geändert|geaendert|ergänzt|ergaenzt|verifiziert|getestet)\b|(?:^|\s)(?:src|tests|docs)\//i.test(
    normalized
  );
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;

  if (mentionsTodoState && defersToEarlierStep) {
    return true;
  }

  if (mentionsTodoState && mentionsProgressOnly && !hasConcreteOutcome && wordCount <= 18) {
    return true;
  }

  if (mentionsDeferredAnswer && defersToEarlierStep && !hasConcreteOutcome && wordCount <= 24) {
    return true;
  }

  return /^(done|complete|completed|erledigt|fertig|ok)[.! ]*$/i.test(normalized);
}

function buildSystemPrompt(
  workspaceRoot: string,
  subagentContext: string,
  workspaceSummary: string,
  resumeContext: string,
  permissions: {
    provider: ModelProvider;
    mode: "plan" | "build" | "bypass";
    allowWrite: boolean;
    allowShell: boolean;
    hasApprovalHandler: boolean;
  },
  experimental: {
    allowExternalFileAnalysis: boolean;
    memoryEnabled: boolean;
    allowShellMetacharacters: boolean;
    ultramaxx: boolean;
    expectsTodos: boolean;
    /** Native tool calling replaces the JSON envelope protocol section. */
    nativeTools: boolean;
  }
): string {
  const workspaceLabel = path.basename(workspaceRoot) || "workspace";
  const writePolicy = permissions.allowWrite
    ? "write tools bypass approval for this run"
    : permissions.hasApprovalHandler && permissions.mode === "build"
      ? "write tools require interactive approval"
      : "write tools are unavailable";
  const shellPolicy = permissions.allowShell
    ? "shell and test tools bypass approval for this run"
    : permissions.hasApprovalHandler && permissions.mode === "build"
      ? "shell and test tools require interactive approval"
      : "shell and test tools are unavailable";
  const bypassPolicy = permissions.allowWrite && permissions.allowShell
    ? "Build+bypass mode may run write, script, test, or shell tools without per-tool approval. Keep actions narrow and avoid broad destructive commands."
    : "Only explicitly enabled permission groups bypass approval. Unavailable tool groups stay blocked.";
  return [
    "You are PatchPilot, a local coding agent running inside a terminal TUI.",
    "You help inspect, edit, test, and explain code inside one workspace.",
    `Runtime OS: ${type()} ${release()} (${platform()}). Use OS-appropriate shell commands and paths.`,
    `Workspace root: ${workspaceRoot}`,
    `Workspace label: ${workspaceLabel}`,
    `Execution mode: ${permissions.mode}.`,
    `Permission policy: ${writePolicy}; ${shellPolicy}.`,
    permissions.mode === "plan"
      ? "Plan mode is read-only: inspect files, explain findings, and return an implementation plan. Do not call write_file, apply_patch, run_script, run_tests, or run_shell."
      : permissions.mode === "bypass"
        ? bypassPolicy
        : "Build mode may request write, script, test, or shell tools when necessary. Prefer focused tool calls and keep risky actions easy to approve.",
    `All tool paths are relative to the workspace root. If the workspace is named "${workspaceLabel}", do not prefix paths with "${workspaceLabel}/". Use "." for the workspace root.`,
    "Treat short questions about this project, its language, stack, quality, architecture, dependencies, tests, or files as workspace questions.",
    "For greetings, small talk, or clearly non-workspace chat, answer normally without tool calls.",
    "For ambiguous pronouns like this project or it, assume the current workspace unless the user points elsewhere.",
    "If you ask the user a question, use a final response and do not call tools.",
    "Do not invent repository facts. If you have not read a file, say you have not verified it.",
    "Never pass placeholder examples like relative/path, path/to/file, or <path> as tool arguments.",
    "For repository summaries, inspect README.md, package.json, tests, docs, and top-level source files before answering.",
    "For implementation tasks, first inspect the narrowest relevant files, then edit only what is needed.",
    experimental.expectsTodos
      ? "This task requires proactive todos. Your FIRST tool call MUST be update_todo with a concrete 2-6 item plan before reading or editing. After each completed step, call update_todo to mark progress. Exactly one item may be in_progress."
      : "If a task needs more than one tool call or touches more than one file, your FIRST tool call MUST be update_todo with a concrete 2-6 item plan. Tiny one-file edits, single-file reads, and direct answers do not need todos.",
    "Todo example required: user asks to fix a provider bug and run tests -> first call update_todo, then inspect, edit, verify, and mark items completed.",
    "Todo example not required: user asks what package manager this repo uses -> inspect package files or answer directly.",
    experimental.ultramaxx
      ? "ULTRAMAXX mode is active: use xhigh care, keep todos mandatory, verify after writes before final, and do not skip self-checks."
      : "",
    experimental.expectsTodos
      ? "Final answers must contain the actual outcome: findings, changes made, verification run, and remaining risks when relevant. Never use final just to say the todo list was updated or that the answer is in a previous step."
      : "",
    "When diagnosing a failure, form a concrete hypothesis, gather targeted evidence with tools, then fix the smallest cause.",
    experimental.allowExternalFileAnalysis
      ? "Experimental file analysis is enabled: inspect_document may inspect supported absolute paths outside the workspace when the user provides them."
      : "Experimental file analysis is disabled: inspect_document is limited to the workspace.",
    experimental.memoryEnabled
      ? "Experimental memory is enabled: use memory_search for relevant durable context and memory_remember when the user asks you to remember something or states durable project guidance."
      : "Experimental memory is disabled.",
    experimental.allowShellMetacharacters
      ? "Experimental shell metacharacters are enabled: run_shell may use pipes, &&, and ;. Redirects, shell expansion, background jobs, OR chains, and multiline commands still require explicit approval even in bypass."
      : "Experimental shell metacharacters are disabled: run_shell may use simple commands and pipes only.",
    "You can reach the web with the fetch_url tool. Never claim you cannot access the internet; if you need a specific page, call fetch_url with a public http(s) URL.",
    workspaceSummary ? ["", "Workspace context:", workspaceSummary].join("\n") : "",
    resumeContext
      ? [
          "",
          "Resumed session context:",
          resumeContext,
          "",
          "Use this as compact historical context. Re-read files before making claims about current workspace contents."
        ].join("\n")
      : "",
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
    // Native tool calling: the runtime enforces the shape, so the prompt only
    // has to carry intent. Repeating a JSON protocol alongside real tools makes
    // some models describe a call in prose instead of emitting one.
    ...(experimental.nativeTools
      ? [
          "Use the provided tools to do the work. Call a tool whenever you need to read, search, change, or run something.",
          "Do not describe a tool call in prose or in a code block — actually call the tool.",
          "You may call several independent tools at once. Read a file before editing it.",
          "Never repeat a tool call that just failed with the same arguments. Change the arguments or try a different approach.",
          "Answer in plain prose only when the work is done or you genuinely cannot proceed.",
          "Keep the todo list current: exactly one item in_progress, finished items completed.",
          "Use bash for git, tests and scripts. Prefer read, glob and grep for reading and searching — they are faster and need no approval."
        ]
      : [
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
    "- update_todo: {\"items\":[{\"id\":\"inspect\",\"content\":\"Inspect relevant files\",\"status\":\"in_progress\"},{\"id\":\"verify\",\"content\":\"Run checks\",\"status\":\"pending\"}]} to maintain the visible task checklist. For multi-step implementation work, call this before and after meaningful task changes.",
    "- list_files: {\"path\":\".\"}",
    "- find_files: {\"query\":\"agent\",\"limit\":80} for matching workspace file paths without reading file contents",
    "- read_file: {\"path\":\"src/index.ts\"}",
    "- read_range: {\"path\":\"src/index.ts\",\"start\":1,\"end\":80}",
    "- file_info: {\"path\":\"src/index.ts\"}",
    "- search_text: {\"query\":\"functionName\"}",
    "- fetch_url: {\"url\":\"https://example.com/page\",\"max_chars\":20000} to fetch a public web page or HTTP API and read it as text. Keyless and available to every model. Pass a plain URL (no Markdown link syntax). Network access needs approval in build mode and is blocked in plan mode; private/loopback hosts are blocked and redirects are not auto-followed.",
    "- inspect_document: {\"path\":\"docs/spec.pdf\",\"mode\":\"auto\"} for pdf, docx, images, and text/code files. Use mode \"local\" or \"ocr\" only when the user explicitly asks for local text/OCR extraction.",
    ...(experimental.memoryEnabled
      ? [
          "- memory_search: {\"query\":\"provider setup\",\"limit\":5}",
          "- memory_remember: {\"content\":\"durable note\",\"tags\":[\"project\"]}"
        ]
      : []),
    "- git_status: {} for current branch and dirty files",
    "- git_diff: {\"path\":\"src/index.ts\"} or {} for all current changes",
    "- git_log: {\"limit\":8} for recent commits without shell access",
    "- git_show: {\"revision\":\"HEAD\",\"path\":\"src/index.ts\"} or {\"revision\":\"HEAD\"} for a compact revision summary",
    "- list_changed_files: {}",
    "- list_scripts: {} for package manager scripts from package.json",
    "- repo_overview: {} for package metadata, Git state, and top-level files",
    "- test_list: {} for likely tests and test-related scripts without running them",
    "- dependency_tree: {} for top-level package dependencies",
    "- write_file: {\"path\":\"test2/test.txt\",\"content\":\"full file content\"} for new files or intentional full-file replacement",
    "- edit_file: {\"path\":\"src/index.ts\",\"find\":\"old unique text\",\"replace\":\"new text\"} or {\"path\":\"src/index.ts\",\"startLine\":10,\"endLine\":12,\"expected\":\"current lines\",\"replacement\":\"new lines\"} for existing files. Include expected with line-range edits when you have read the target lines.",
    "- create_pdf: {\"path\":\"docs/summary.pdf\",\"title\":\"Summary\",\"content\":\"plain text\"}",
    "- create_docx: {\"path\":\"docs/summary.docx\",\"title\":\"Summary\",\"content\":\"plain text\"}",
    "- apply_patch: {\"patch\":\"unified git patch\"}",
    "- run_script: {\"script\":\"test\"}",
    "- run_tests: {}",
    "- run_shell: {\"command\":\"single simple command to run in the workspace\"}"
        ]),
    "",
    "Act like a coding agent. For simple create/edit/run requests, use tools directly instead of over-warning.",
    "Do not call search_text with an empty query. Use list_files {\"path\":\".\"} to inspect a directory.",
    "Prefer reading before risky edits. For existing files, prefer edit_file or apply_patch over full-file write_file.",
    "Batch small related tool calls in one response when it helps avoid extra thinking steps.",
    "Keep update_todo current: mark exactly what you are doing as in_progress and completed tasks as completed.",
    "In final answers, separate verified facts from remaining risks.",
    "Keep tool requests and final answers compact."
  ].join("\n");
}

/** Unwraps a narrated protocol envelope so it never reaches the user raw. */
export function readFinalMessage(rawResponse: string): string {
  const trimmed = rawResponse.trim();
  if (!trimmed.startsWith("{") || !trimmed.includes('"action"')) {
    return trimmed;
  }

  const message = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(trimmed)?.[1];
  if (!message) {
    return "Done.";
  }

  try {
    return JSON.parse(`"${message}"`) as string;
  } catch {
    return message;
  }
}

function looksLikeClarification(message: string): boolean {
  const normalizedMessage = message.trim().toLowerCase();
  return (
    normalizedMessage.endsWith("?") &&
    /\b(what|which|please provide|would you like|do you want|can you specify|welche|was genau|bitte)\b/.test(normalizedMessage)
  );
}

export function shouldStopAfterEmptyToolBatches(emptyToolBatches: number): boolean {
  return emptyToolBatches >= 2;
}

export function findRepeatedToolCall(toolCalls: Parameters<WorkspaceTools["execute"]>[0][], recentSignatures: string[]): Parameters<WorkspaceTools["execute"]>[0] | null {
  for (const toolCall of toolCalls) {
    const signature = toolCallSignature(toolCall);
    recentSignatures.push(signature);
    while (recentSignatures.length > 6) {
      recentSignatures.shift();
    }

    if (recentSignatures.filter((item) => item === signature).length >= 3) {
      return toolCall;
    }
  }

  return null;
}

function toolCallSignature(toolCall: Parameters<WorkspaceTools["execute"]>[0]): string {
  return `${toolCall.name}:${stableStringify(toolCall.arguments)}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
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

function splitTodoToolCalls(toolCalls: Parameters<WorkspaceTools["execute"]>[0][]): {
  todoCalls: Parameters<WorkspaceTools["execute"]>[0][];
  workspaceCalls: Parameters<WorkspaceTools["execute"]>[0][];
} {
  return {
    todoCalls: toolCalls.filter((toolCall) => toolCall.name === "update_todo"),
    workspaceCalls: toolCalls.filter((toolCall) => toolCall.name !== "update_todo")
  };
}

export function normalizeTodoItems(argumentsValue: Record<string, unknown>, existingItems: AgentTodoItem[] = []): AgentTodoItem[] {
  const rawItems = Array.isArray(argumentsValue.items) ? argumentsValue.items : Array.isArray(argumentsValue.todos) ? argumentsValue.todos : [];
  const existingById = new Map(existingItems.map((item) => [item.id, item]));
  const normalizedItems: AgentTodoItem[] = [];

  for (const rawItem of rawItems.slice(0, 12)) {
    if (!isRecord(rawItem)) {
      continue;
    }
    const content = readTodoString(rawItem.content) || readTodoString(rawItem.text) || readTodoString(rawItem.task);
    if (!content) {
      continue;
    }
    const explicitId = readTodoString(rawItem.id);
    const id = sanitizeTodoId(explicitId || existingById.get(content)?.id || content);
    const status = normalizeTodoStatus(rawItem.status);
    normalizedItems.push({
      id,
      content: content.slice(0, 120),
      status
    });
  }

  return dedupeTodoItems(normalizedItems);
}

function summarizeTodos(items: AgentTodoItem[]): string {
  const completed = items.filter((item) => item.status === "completed").length;
  const active = items.find((item) => item.status === "in_progress");
  return active ? `${completed}/${items.length} done, working on ${active.content}` : `${completed}/${items.length} todos done`;
}

function hasOpenTodos(items: AgentTodoItem[]): boolean {
  return items.some((item) => item.status === "pending" || item.status === "in_progress");
}

function dedupeTodoItems(items: AgentTodoItem[]): AgentTodoItem[] {
  const seen = new Set<string>();
  const deduped: AgentTodoItem[] = [];
  for (const item of items) {
    const uniqueId = seen.has(item.id) ? `${item.id}-${deduped.length + 1}` : item.id;
    seen.add(uniqueId);
    deduped.push({ ...item, id: uniqueId });
  }
  return deduped;
}

function normalizeTodoStatus(value: unknown): AgentTodoItem["status"] {
  const normalized = typeof value === "string" ? value.trim().toLowerCase().replace(/[- ]/g, "_") : "";
  if (normalized === "done" || normalized === "complete" || normalized === "completed" || normalized === "checked") {
    return "completed";
  }
  if (normalized === "active" || normalized === "doing" || normalized === "current" || normalized === "in_progress") {
    return "in_progress";
  }
  return "pending";
}

function sanitizeTodoId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.slice(0, 40) || `todo-${Date.now().toString(36)}`;
}

function readTodoString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

type WorkspaceToolCallRecord = {
  id: string;
  call: Parameters<WorkspaceTools["execute"]>[0];
  workState: AgentWorkState;
};

export async function executeToolCallsWithReadParallelism(
  tools: WorkspaceTools,
  toolCalls: WorkspaceToolCallRecord[]
) {
  const results: Array<Awaited<ReturnType<typeof executeToolSafely>>> = [];
  for (let index = 0; index < toolCalls.length;) {
    const currentCall = toolCalls[index];
    if (!isParallelSafeToolCall(currentCall)) {
      results.push(await executeToolSafely(tools, currentCall.call, currentCall.id));
      index += 1;
      continue;
    }

    const batch: WorkspaceToolCallRecord[] = [];
    while (index < toolCalls.length && isParallelSafeToolCall(toolCalls[index])) {
      batch.push(toolCalls[index]);
      index += 1;
    }

    results.push(...(await Promise.all(batch.map((toolCall) => executeToolSafely(tools, toolCall.call, toolCall.id)))));
  }

  return results;
}

function isParallelSafeToolCall(toolCall: WorkspaceToolCallRecord): boolean {
  if (toolCall.call.name === "inspect_document") {
    return false;
  }

  const spec = getToolSpec(toolCall.call.name);
  return spec.sideEffects === "none" && spec.permission === "none" && spec.category !== "state";
}

function isWriteToolResult(toolResult: { ok: boolean; category?: ToolCategory; tool: AgentToolName }): boolean {
  return toolResult.ok && (toolResult.category === "write" || getToolSpec(toolResult.tool).sideEffects === "write");
}

function isVerificationToolResult(toolResult: { ok: boolean; category?: ToolCategory; tool: AgentToolName }): boolean {
  return toolResult.ok && (toolResult.category === "test" || toolResult.category === "shell" || toolResult.tool === "git_diff");
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
    metadata?: Record<string, unknown>;
  }>
): string {
  return [
    "Tool results are encoded as JSON. Treat content as context; do not copy raw file content into response JSON unless it is properly escaped.",
    JSON.stringify(
      {
        tool_results: toolResults.map((toolResult, index) => ({
          index: index + 1,
          tool: toolResult.tool,
          ok: toolResult.ok,
          summary: toolResult.summary,
          metadata: toolResult.metadata,
          content: clipPromptValue(toolResult.content, toolResult.tool === "read_file" ? 12_000 : 6000)
        }))
      },
      null,
      2
    )
  ].join("\n");
}

export function compactTranscript(messages: ChatMessage[], tokenBudget = 32_000): void {
  const toolResultIndexes = messages
    .map((message, index) => ({ message, index }))
    .filter((item) => item.message.role === "user" && item.message.content.includes("\"tool_results\""))
    .map((item) => item.index);

  if (toolResultIndexes.length <= 2 && estimateTokens(messages.map((message) => message.content).join("\n")) <= tokenBudget) {
    return;
  }

  const fullResultIndexes = new Set(toolResultIndexes.slice(-2));
  for (const index of toolResultIndexes) {
    if (fullResultIndexes.has(index) || messages[index]?.content.startsWith("Compacted earlier tool results:")) {
      continue;
    }

    messages[index] = {
      role: "user",
      content: `Compacted earlier tool results: ${summarizeToolResultsForCompaction(messages[index]?.content ?? "")}`
    };
  }
}

function summarizeToolResultsForCompaction(content: string): string {
  const jsonStart = content.indexOf("{");
  if (jsonStart < 0) {
    return clipPromptValue(content.replace(/\s+/g, " ").trim(), 240);
  }

  try {
    const parsed = JSON.parse(content.slice(jsonStart)) as {
      tool_results?: Array<{
        tool?: unknown;
        ok?: unknown;
        summary?: unknown;
      }>;
    };
    const results = Array.isArray(parsed.tool_results) ? parsed.tool_results : [];
    return results
      .map((result, index) => {
        const tool = typeof result.tool === "string" ? result.tool : `tool ${index + 1}`;
        const status = result.ok === false ? "failed" : "ok";
        const summary = typeof result.summary === "string" ? result.summary.replace(/\s+/g, " ").trim() : "";
        return `${tool} ${status}${summary ? `: ${clipPromptValue(summary, 140)}` : ""}`;
      })
      .join("; ");
  } catch {
    return clipPromptValue(content.replace(/\s+/g, " ").trim(), 240);
  }
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
  const [patchPilotInstructions, packageJson, tsconfig, readme, productContext, architecture, commands] = await Promise.all([
    readWorkspaceFile(workspaceRoot, "PATCHPILOT.md", 4000),
    readWorkspaceFile(workspaceRoot, "package.json", 4000),
    readWorkspaceFile(workspaceRoot, "tsconfig.json", 1600),
    readWorkspaceFile(workspaceRoot, "README.md", 3000),
    readWorkspaceFile(workspaceRoot, "docs/product-context.md", 4000),
    readWorkspaceFile(workspaceRoot, "docs/architecture.md", 2200),
    readWorkspaceFile(workspaceRoot, "src/tui/commands.ts", 2400)
  ]);

  return [
    patchPilotInstructions ? `PATCHPILOT.md instructions:\n${patchPilotInstructions}` : "",
    productContext ? `PatchPilot product context:\n${productContext}` : "",
    packageJson ? `package.json:\n${packageJson}` : "",
    tsconfig ? `tsconfig.json:\n${tsconfig}` : "",
    readme ? `README excerpt:\n${readme}` : "",
    architecture ? `Architecture excerpt:\n${architecture}` : "",
    commands ? `TUI command definitions excerpt:\n${commands}` : ""
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

function resolveMaxSteps(task: string, configuredMaxSteps: number, thinkingMode: AgentRunnerOptions["thinkingMode"], ultramaxx = false): number {
  if (thinkingMode !== "adaptive") {
    return Math.max(2, configuredMaxSteps);
  }

  const words = task.trim().split(/\s+/).filter(Boolean).length;
  const looksComplex = shouldUseSubagents(task) || words > 18 || /\b(implement|refactor|debug|fix|review|architektur|performance|pipeline|context|memory|provider)\b/i.test(task);
  if (ultramaxx) {
    return Math.max(40, configuredMaxSteps);
  }
  const adaptiveSteps = looksComplex ? Math.max(configuredMaxSteps, 12) : Math.min(configuredMaxSteps, 5);
  return Math.max(3, Math.min(20, adaptiveSteps));
}

function shouldExtendAdaptiveRun(
  task: string,
  toolResults: Array<{
    ok: boolean;
    summary: string;
    tool?: AgentToolName;
    category?: ToolCategory;
    metadata?: Record<string, unknown>;
  }>,
  currentMaxSteps: number,
  ceiling = 32
): boolean {
  if (currentMaxSteps >= ceiling) {
    return false;
  }

  const hasUsefulProgress = toolResults.some((result) =>
    result.ok &&
    (result.category === "write" ||
      result.category === "test" ||
      result.category === "shell" ||
      result.tool === "git_diff" ||
      (result.tool === "update_todo" && todoMetadataHasCompletedItem(result.metadata)))
  );
  const hasRecoverableFailure = toolResults.some((result) => !result.ok && /not found|missing|requires|denied|failed|unreadable/i.test(result.summary));
  return hasUsefulProgress || hasRecoverableFailure || (shouldUseSubagents(task) && hasUsefulProgress);
}

function todoMetadataHasCompletedItem(metadata: Record<string, unknown> | undefined): boolean {
  const items = Array.isArray(metadata?.items) ? metadata.items : [];
  return items.some((item) => isRecord(item) && item.status === "completed");
}

function clipPromptValue(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n...[clipped ${value.length - maxLength} chars]`;
}

function isRetryableModelError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(429|500|502|503|504|rate limit|timeout|timed out|socket|econnreset|network|temporar|could not be reached|cannot reach)\b/i.test(message);
}

function formatRetryableModelError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return clipPromptValue(message.replace(/\s+/g, " ").trim(), 120);
}

function modelRetryDelayMs(attempt: number): number {
  return Math.min(4000, 300 * 2 ** Math.max(0, attempt - 1) + Math.floor(Math.random() * 250));
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}
