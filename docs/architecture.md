# Architecture

PatchPilot is split into a small agent core and an Ink terminal interface.

## Components

| Component | Responsibility |
|---|---|
| `OllamaClient` | Sends chat requests to the local Ollama HTTP API |
| `AgentRunner` | Maintains the model loop and executes typed tool calls |
| `WorkspaceTools` | Provides bounded file, search, write, and shell actions |
| `App` | Renders the TUI transcript, status, and prompt input |

## Agent Protocol

The first version uses a JSON command envelope instead of provider-specific tool calling. That keeps behavior portable across local models, including models that do not reliably emit native tool calls.

Tool request:

```json
{
  "action": "tools",
  "message": "I need to inspect the project files.",
  "tool_calls": [
    {
      "name": "list_files",
      "arguments": {
        "path": "."
      }
    }
  ]
}
```

Final answer:

```json
{
  "action": "final",
  "message": "The repository is a TypeScript TUI agent..."
}
```

## Safety

The workspace root is resolved once at startup. Every file path is resolved against that root and rejected if it escapes the workspace. Writes and shell commands are disabled by default.
