export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type ModelProvider = "ollama" | "local-openai";
/** Thinking is either left to the model ("auto") or forced on/off. */
export type ThinkingSetting = "auto" | "on" | "off";

/** Incremental output from a streaming response. */
export type ModelStreamDelta = {
  /** Visible assistant output. */
  content?: string;
  /** Reasoning text, where the runtime reports it separately from content. */
  thinking?: string;
};

/** A tool advertised to the runtime, in the shape both providers accept. */
export type ProviderTool = {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
};

/** A tool call as the runtime reported it, before any repair. */
export type RawToolCall = {
  name: unknown;
  arguments: unknown;
};

export type ModelChatOptions = {
  model: string;
  messages: ChatMessage[];
  formatJson?: boolean;
  /**
   * Tools to advertise. Passing these enables native tool calling and, where
   * the runtime supports it, grammar-constrained decoding against each schema.
   */
  tools?: ProviderTool[];
  thinking?: ThinkingSetting;
  signal?: AbortSignal;
  /**
   * Called as tokens arrive. Providing it enables streaming; omitting it
   * requests a single buffered response. The callback must not throw — a
   * failing renderer should never abort a model call.
   */
  onDelta?: (delta: ModelStreamDelta) => void;
};

export type ModelFileAnalysisOptions = {
  model: string;
  path: string;
  prompt: string;
  signal?: AbortSignal;
};

export type ModelChatResult = {
  content: string;
  /** Native tool calls, when the runtime emitted any. */
  toolCalls?: RawToolCall[];
  telemetry: ModelTelemetry;
  /** Provider-side notice worth surfacing (e.g. model fallback, cookie retry). */
  warning?: string;
};

export type ModelDescriptor = {
  id: string;
  modelName?: string;
  displayName?: string;
  description?: string;
  isAvailable?: boolean;
  capacity?: number;
  capacityField?: number;
  advancedOnly?: boolean;
  legacy?: boolean;
};

export type ModelClient = {
  chat(options: ModelChatOptions): Promise<ModelChatResult>;
  listModels(): Promise<string[]>;
  listModelDescriptors?(): Promise<ModelDescriptor[]>;
  supportsFileAnalysis?(): boolean;
  analyzeFile?(options: ModelFileAnalysisOptions): Promise<ModelChatResult>;
};

export type AgentWorkState =
  | "idle"
  | "inspecting"
  | "planning"
  | "reading"
  | "editing"
  | "verifying"
  | "waiting_approval"
  | "done"
  | "error";

export const AGENT_TOOL_NAMES = [
  "update_todo",
  "list_files",
  "find_files",
  "read_file",
  "read_range",
  "file_info",
  "search_text",
  "fetch_url",
  "inspect_document",
  "memory_remember",
  "memory_search",
  "git_status",
  "git_diff",
  "git_log",
  "git_show",
  "list_changed_files",
  "list_scripts",
  "repo_overview",
  "test_list",
  "dependency_tree",
  "write_file",
  "edit_file",
  "create_pdf",
  "create_docx",
  "apply_patch",
  "run_script",
  "run_tests",
  "run_shell"
] as const;

export const MAX_TOOL_CALLS_PER_RESPONSE = 12;

export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

export type AgentToolCall = {
  name: AgentToolName;
  arguments: Record<string, unknown>;
};

export type ToolRisk = "low" | "medium" | "high";

export type ToolSideEffect = "none" | "write" | "shell";

export type ToolPermission = "none" | "write" | "shell" | "external_file" | "network";

export type ToolCategory = "state" | "read" | "search" | "write" | "shell" | "git" | "test" | "document" | "memory";

export type ToolSpec = {
  name: AgentToolName;
  description: string;
  risk: ToolRisk;
  sideEffects: ToolSideEffect;
  permission: ToolPermission;
  category: ToolCategory;
};

export type PermissionDecision = "allow_once" | "allow_session" | "deny";

export type ApprovalRequest = {
  id: string;
  tool: AgentToolName;
  permission: Exclude<ToolPermission, "none">;
  risk: ToolRisk;
  preview: string;
  arguments: Record<string, unknown>;
  bypassable?: boolean;
};

export type AgentResponse =
  | {
      action: "tools";
      message: string;
      tool_calls: AgentToolCall[];
    }
  | {
      action: "final";
      message: string;
    };


export type AgentTodoStatus = "pending" | "in_progress" | "completed";

export type AgentTodoItem = {
  id: string;
  content: string;
  status: AgentTodoStatus;
};

export type AgentEvent =
  | {
      type: "status";
      message: string;
      workState: AgentWorkState;
    }
  | {
      type: "metrics";
      metrics: ModelTelemetry;
      workState: AgentWorkState;
    }
  | {
      type: "assistant";
      message: string;
      workState: AgentWorkState;
    }
  /**
   * Live progress within a single model call. `prompt` covers the wait before
   * the first token — on local hardware that is prompt evaluation, and it is
   * most of the perceived latency on a long context. `generating` starts at
   * the first token and carries a running throughput figure.
   */
  | {
      type: "stream";
      phase: "prompt" | "generating";
      elapsedMs: number;
      /** Tokens emitted so far; only meaningful while generating. */
      tokens: number;
      tokensPerSecond: number | null;
      workState: AgentWorkState;
    }
  /** Reasoning text, where the runtime reports it apart from the answer. */
  | {
      type: "thinking";
      message: string;
      workState: AgentWorkState;
    }
  /** How much of the model's real context window the conversation occupies. */
  | {
      type: "context";
      usedTokens: number;
      limitTokens: number;
      ratio: number;
      pressure: "ok" | "warn" | "high" | "critical";
      workState: AgentWorkState;
    }
  | {
      type: "tool";
      name: AgentToolName;
      summary: string;
      content?: string;
      ok: boolean;
      workState: AgentWorkState;
      toolCallId?: string;
      category?: ToolCategory;
      preview?: string;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "todo";
      items: AgentTodoItem[];
      summary: string;
      workState: AgentWorkState;
    }
  | {
      type: "approval";
      request: ApprovalRequest;
      decision: PermissionDecision;
      workState: AgentWorkState;
    }
  | {
      type: "final";
      message: string;
      workState: AgentWorkState;
    }
  | {
      type: "error";
      message: string;
      workState: AgentWorkState;
    };

export type ToolResult = {
  ok: boolean;
  summary: string;
  content: string;
  tool?: AgentToolName;
  category?: ToolCategory;
  preview?: string;
  approval?: {
    request: ApprovalRequest;
    decision: PermissionDecision;
  };
  metadata?: Record<string, unknown>;
};

export type SessionEvent =
  | {
      type: "session.created";
      sessionId: string;
      workspace: string;
      createdAt: string;
    }
  | {
      type: "session.resumed";
      sessionId: string;
      workspace: string;
      resumedAt: string;
    }
  | {
      type: "run.started";
      runId: string;
      task: string;
      provider: ModelProvider;
      model: string;
      startedAt: string;
    }
  | {
      type: "model.request";
      runId: string;
      workState: AgentWorkState;
      provider: ModelProvider;
      model: string;
      step: number;
      createdAt: string;
    }
  | {
      type: "tool.requested";
      runId: string;
      toolCallId: string;
      tool: AgentToolName;
      arguments: Record<string, unknown>;
      workState: AgentWorkState;
      createdAt: string;
    }
  | {
      type: "approval.requested";
      runId: string;
      request: ApprovalRequest;
      decision: PermissionDecision;
      createdAt: string;
    }
  | {
      type: "todo.updated";
      runId: string;
      items: AgentTodoItem[];
      summary: string;
      createdAt: string;
    }
  | {
      type: "tool.completed";
      runId: string;
      toolCallId: string;
      tool: AgentToolName;
      ok: boolean;
      summary: string;
      workState: AgentWorkState;
      createdAt: string;
    }
  | {
      type: "run.completed";
      runId: string;
      message: string;
      completedAt: string;
    }
  | {
      type: "run.failed";
      runId: string;
      message: string;
      failedAt: string;
    }
  | {
      type: "context.pinned";
      runId?: string;
      itemId: string;
      pinned: boolean;
      label?: string;
      createdAt: string;
    }
  | {
      type: "context.compacted";
      runId?: string;
      summaryId: string;
      itemIds: string[];
      createdAt: string;
    };

export type ModelTelemetry = {
  promptTokens: number;
  cachedPromptTokens: number;
  cacheWriteTokens: number;
  responseTokens: number;
  totalTokens: number;
  evalTokensPerSecond: number | null;
  /**
   * Time until the first token arrived. Null for non-streaming responses.
   * Kept separate from promptDurationMs because on local hardware prompt
   * evaluation is what a user actually waits through.
   */
  timeToFirstTokenMs: number | null;
  promptDurationMs: number;
  responseDurationMs: number;
  totalDurationMs: number;
  estimatedCostUsd: number | null;
  tokenSource: "provider" | "estimated";
  costSource: "api-pricing" | "local" | "unknown" | "fallback-pricing" | "free-route";
};

export type SessionTelemetry = {
  requests: number;
  promptTokens: number;
  cachedPromptTokens: number;
  cacheWriteTokens: number;
  responseTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | null;
  costSource: "api-pricing" | "local" | "unknown" | "fallback-pricing" | "free-route" | "mixed";
};
