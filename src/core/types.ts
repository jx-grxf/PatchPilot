export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type AgentToolName =
  | "list_files"
  | "read_file"
  | "search_text"
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

export type AgentEvent =
  | {
      type: "status";
      message: string;
    }
  | {
      type: "assistant";
      message: string;
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
