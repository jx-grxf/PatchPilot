import type { AgentToolCall, ToolCategory, ToolPermission, ToolRisk, ToolSideEffect } from "./types.js";

/** Mirrors the TUI mode without importing across the core/tui boundary. */
export type ToolMode = "plan" | "build" | "bypass";

/**
 * The nine-tool surface.
 *
 * PatchPilot used to expose 28 tools described only as prose in the system
 * prompt. Small local models format a call far more reliably than they pick
 * the right one, and the practical ceiling is three to five *relevant* tools
 * per decision — so the surface is nine, each with a real JSON Schema the
 * runtime can constrain generation against. Git, tests and scripts moved
 * behind `bash`, which is what a model already knows how to drive.
 *
 * Descriptions stay deliberately rich. Over-constraining an open-weight model
 * measurably suppresses tool calling, so the schema pins the shape while the
 * prose carries the intent.
 */

export type JsonSchema = {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties: false;
};

export type JsonSchemaProperty = {
  type: "string" | "number" | "integer" | "boolean" | "array";
  description: string;
  enum?: string[];
  items?: { type: "string" | "object"; properties?: Record<string, JsonSchemaProperty>; required?: string[] };
  minimum?: number;
  default?: string | number | boolean;
};

export const TOOL_NAMES = ["read", "write", "edit", "glob", "grep", "bash", "fetch_url", "task", "todo"] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export type ToolDefinition = {
  name: ToolName;
  description: string;
  inputSchema: JsonSchema;
  risk: ToolRisk;
  sideEffects: ToolSideEffect;
  permission: ToolPermission;
  category: ToolCategory;
  /** Read-only tools stay available in plan mode. */
  readOnly: boolean;
};

export const toolDefinitions: Record<ToolName, ToolDefinition> = {
  read: {
    name: "read",
    description:
      "Read a file from the workspace. Returns the contents with line numbers. Use offset and limit to read part of a large file instead of pulling the whole thing into context. Always read a file before editing it.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative path to the file, e.g. src/core/agent.ts" },
        offset: { type: "integer", description: "First line to read, 1-based. Omit to start at the beginning.", minimum: 1 },
        limit: { type: "integer", description: "How many lines to read. Omit to read to the end.", minimum: 1 }
      },
      required: ["path"],
      additionalProperties: false
    },
    risk: "low",
    sideEffects: "none",
    permission: "none",
    category: "read",
    readOnly: true
  },

  write: {
    name: "write",
    description:
      "Write a complete file, creating it or replacing its entire contents. Use this only for new files or a deliberate full rewrite; to change part of an existing file use edit, which is safer and cheaper.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative path to write." },
        content: { type: "string", description: "The full file contents. Not a fragment — whatever is here becomes the whole file." }
      },
      required: ["path", "content"],
      additionalProperties: false
    },
    risk: "high",
    sideEffects: "write",
    permission: "write",
    category: "write",
    readOnly: false
  },

  edit: {
    name: "edit",
    description:
      "Replace an exact string in a file. old_string must match the file byte for byte, including indentation, and must be unique unless replace_all is true. Read the file first so the match is exact.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative path to edit." },
        old_string: { type: "string", description: "Exact text to find, including surrounding lines if needed to make it unique." },
        new_string: { type: "string", description: "Text to put in its place." },
        replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match.", default: false }
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false
    },
    risk: "high",
    sideEffects: "write",
    permission: "write",
    category: "write",
    readOnly: false
  },

  glob: {
    name: "glob",
    description:
      "Find files by name pattern, e.g. **/*.ts or src/core/*.test.ts. Returns matching paths. Use this to discover where something lives; use grep to search inside files.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern to match against workspace-relative paths." },
        limit: { type: "integer", description: "Maximum paths to return. Defaults to 80.", minimum: 1 }
      },
      required: ["pattern"],
      additionalProperties: false
    },
    risk: "low",
    sideEffects: "none",
    permission: "none",
    category: "search",
    readOnly: true
  },

  grep: {
    name: "grep",
    description:
      "Search file contents for a pattern and return matching lines with their paths. This is the fastest way to locate a symbol, string, or usage across the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Text or regular expression to search for." },
        path: { type: "string", description: "Directory to search under. Omit to search the whole workspace." }
      },
      required: ["pattern"],
      additionalProperties: false
    },
    risk: "low",
    sideEffects: "none",
    permission: "none",
    category: "search",
    readOnly: true
  },

  bash: {
    name: "bash",
    description:
      "Run a shell command in the workspace root. This is how you use git (status, diff, log, show), run tests and build scripts, and inspect the project. Prefer the dedicated read, glob and grep tools for reading and searching — they are faster and do not need approval.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to run, e.g. git diff --stat or npm test" },
        description: { type: "string", description: "Short description of what this command does, shown in the approval prompt." }
      },
      required: ["command"],
      additionalProperties: false
    },
    risk: "high",
    sideEffects: "shell",
    permission: "shell",
    category: "shell",
    readOnly: false
  },

  fetch_url: {
    name: "fetch_url",
    description:
      "Fetch a public http(s) URL and return its readable text. Use this when you need the actual contents of a specific page. You do have web access through this tool — never claim otherwise.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL. Private and loopback addresses are rejected." },
        max_chars: { type: "integer", description: "Truncate the extracted text to this many characters.", minimum: 1 }
      },
      required: ["url"],
      additionalProperties: false
    },
    risk: "medium",
    sideEffects: "none",
    permission: "network",
    category: "search",
    readOnly: true
  },

  task: {
    name: "task",
    description:
      "Delegate a self-contained piece of work to a subagent with its own context. Use this when a task needs a lot of exploration whose detail you do not need to keep — the subagent reads widely and returns only its conclusion, which keeps your own context small.",
    inputSchema: {
      type: "object",
      properties: {
        description: { type: "string", description: "Short description of the task, 3-6 words." },
        prompt: { type: "string", description: "The full instruction for the subagent. It cannot see this conversation, so include everything it needs." },
        subagent_type: {
          type: "string",
          description: "explore reads and reports without changing anything; general can also edit files.",
          enum: ["explore", "general"]
        }
      },
      required: ["description", "prompt", "subagent_type"],
      additionalProperties: false
    },
    risk: "medium",
    sideEffects: "none",
    permission: "none",
    category: "state",
    readOnly: true
  },

  todo: {
    name: "todo",
    description:
      "Record or update your task list. Keep it current: mark an item in_progress when you start it and completed the moment it is done. This is how the user follows what you are doing on a long task.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "The full list, in order. Send every item each time, not just the changed one.",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "What the step accomplishes." },
              status: { type: "string", description: "pending, in_progress, or completed.", enum: ["pending", "in_progress", "completed"] }
            },
            required: ["title", "status"]
          }
        }
      },
      required: ["items"],
      additionalProperties: false
    },
    risk: "low",
    sideEffects: "none",
    permission: "none",
    category: "state",
    readOnly: true
  }
};

/**
 * Which tools a mode exposes. Gating by mode keeps the live count near the
 * three-to-five band where small models still choose well, and makes plan mode
 * read-only by construction rather than by asking the model nicely.
 */
export function toolsForMode(mode: ToolMode, options: { subagents: boolean } = { subagents: true }): ToolDefinition[] {
  return TOOL_NAMES.map((name) => toolDefinitions[name])
    .filter((tool) => (mode === "plan" ? tool.readOnly : true))
    .filter((tool) => (tool.name === "task" ? options.subagents : true));
}

/** Ollama and OpenAI-compatible servers share the same tool envelope. */
export function toProviderTools(tools: ToolDefinition[]): Array<{
  type: "function";
  function: { name: string; description: string; parameters: JsonSchema };
}> {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema
    }
  }));
}

export function isToolName(value: unknown): value is ToolName {
  return typeof value === "string" && (TOOL_NAMES as readonly string[]).includes(value);
}

export function getToolDefinition(name: ToolName): ToolDefinition {
  return toolDefinitions[name];
}

/**
 * Maps a call against the nine-tool surface onto the underlying workspace
 * implementation, which still speaks the older, wider vocabulary. Keeping the
 * two apart means the tested file, search and git code is untouched by the
 * surface change.
 */
export function toWorkspaceCall(name: ToolName, args: Record<string, unknown>): AgentToolCall {
  switch (name) {
    case "read": {
      const offset = readInteger(args.offset);
      const limit = readInteger(args.limit);
      if (offset === null && limit === null) {
        return { name: "read_file", arguments: { path: args.path } };
      }

      const start = offset ?? 1;
      return {
        name: "read_range",
        arguments: { path: args.path, start, end: limit === null ? start + 400 : start + limit - 1 }
      };
    }
    case "write":
      return { name: "write_file", arguments: { path: args.path, content: args.content } };
    case "edit":
      return {
        name: "edit_file",
        arguments: {
          path: args.path,
          find: args.old_string,
          replace: args.new_string,
          replace_all: args.replace_all ?? false
        }
      };
    case "glob":
      return { name: "find_files", arguments: { query: args.pattern, limit: args.limit ?? 80 } };
    case "grep":
      return { name: "search_text", arguments: { query: args.pattern, path: args.path ?? "" } };
    case "bash":
      return { name: "run_shell", arguments: { command: args.command } };
    case "fetch_url":
      return { name: "fetch_url", arguments: { url: args.url, max_chars: args.max_chars ?? 0 } };
    case "todo":
      return { name: "update_todo", arguments: { items: args.items } };
    case "task":
      // Subagents are dispatched by the agent loop, not the workspace.
      return { name: "update_todo", arguments: { items: [] } };
  }
}

function readInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}
