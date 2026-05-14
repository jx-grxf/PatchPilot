export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type ModelProvider = "ollama" | "gemini" | "codex" | "openrouter" | "nvidia";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type ProviderReasoningEffort = ReasoningEffort | "none";

export type ModelChatOptions = {
  model: string;
  messages: ChatMessage[];
  formatJson?: boolean;
  reasoningEffort?: ProviderReasoningEffort;
  signal?: AbortSignal;
};

export type ModelChatResult = {
  content: string;
  telemetry: ModelTelemetry;
};

export type ModelClient = {
  chat(options: ModelChatOptions): Promise<ModelChatResult>;
  listModels(): Promise<string[]>;
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

export type AgentToolName =
  | "list_files"
  | "read_file"
  | "read_range"
  | "file_info"
  | "search_text"
  | "inspect_document"
  | "git_status"
  | "git_diff"
  | "list_changed_files"
  | "list_scripts"
  | "write_file"
  | "apply_patch"
  | "run_script"
  | "run_tests"
  | "run_shell";

export type AgentToolCall = {
  name: AgentToolName;
  arguments: Record<string, unknown>;
};

export type ToolRisk = "low" | "medium" | "high";

export type ToolSideEffect = "none" | "write" | "shell";

export type ToolPermission = "none" | "write" | "shell";

export type ToolCategory = "read" | "search" | "write" | "shell" | "git" | "test" | "document";

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

export type SubagentRole = "planner" | "reviewer" | "explorer";

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
  | {
      type: "subagent";
      role: SubagentRole;
      message: string;
      metrics: ModelTelemetry;
      workState: AgentWorkState;
    }
  | {
      type: "tool";
      name: AgentToolName;
      summary: string;
      ok: boolean;
      workState: AgentWorkState;
      toolCallId?: string;
      category?: ToolCategory;
      preview?: string;
      metadata?: Record<string, unknown>;
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
    };

export type ModelTelemetry = {
  promptTokens: number;
  cachedPromptTokens: number;
  cacheWriteTokens: number;
  responseTokens: number;
  totalTokens: number;
  evalTokensPerSecond: number | null;
  promptDurationMs: number;
  responseDurationMs: number;
  totalDurationMs: number;
  estimatedCostUsd: number | null;
  tokenSource: "provider" | "estimated";
  costSource: "api-pricing" | "local" | "unknown";
};

export type SessionTelemetry = {
  requests: number;
  promptTokens: number;
  cachedPromptTokens: number;
  cacheWriteTokens: number;
  responseTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | null;
};
