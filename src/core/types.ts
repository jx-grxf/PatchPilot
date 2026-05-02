export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type ModelProvider = "ollama" | "gemini" | "codex" | "openrouter" | "nvidia";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export type ModelChatOptions = {
  model: string;
  messages: ChatMessage[];
  formatJson?: boolean;
  reasoningEffort?: ReasoningEffort;
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

export type AgentToolName =
  | "list_files"
  | "read_file"
  | "search_text"
  | "inspect_document"
  | "write_file"
  | "run_shell";

export type AgentToolCall = {
  name: AgentToolName;
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
    }
  | {
      type: "metrics";
      metrics: ModelTelemetry;
    }
  | {
      type: "assistant";
      message: string;
    }
  | {
      type: "subagent";
      role: SubagentRole;
      message: string;
      metrics: ModelTelemetry;
    }
  | {
      type: "tool";
      name: AgentToolName;
      summary: string;
      ok: boolean;
    }
  | {
      type: "final";
      message: string;
    }
  | {
      type: "error";
      message: string;
    };

export type ToolResult = {
  ok: boolean;
  summary: string;
  content: string;
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
