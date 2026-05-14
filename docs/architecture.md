# Architecture

PatchPilot is split into a small agent core and an Ink terminal interface.

## Components

| Component | Responsibility |
|---|---|
| `OllamaClient` | Sends chat requests to the selected Ollama HTTP API and reads host model state |
| `compute` | Classifies the selected Ollama endpoint as local or remote compute |
| `subagents` | Runs small planner/reviewer advisor calls before the primary agent loop |
| `AgentRunner` | Maintains the model loop, work-state transitions, session events, and typed tool calls |
| `WorkspaceTools` | Provides bounded file, search, patch, Git, test, and shell actions |
| `SessionStore` | Persists append-only JSONL session events and updates the global session index |
| `App` | Renders the TUI transcript, approval prompts, status, and prompt input |
| `systemStats` | Samples CPU and memory usage for the live header telemetry |

## Compute Model

PatchPilot separates the client machine from the compute machine:

- The client machine runs the TUI, reads and writes workspace files, runs Git, and executes tests.
- The compute machine runs Ollama inference.
- `/connect` changes only the Ollama compute endpoint. It does not move workspace tools to the remote host.
- Host discovery checks both the local LAN and reachable Tailscale peers, then verifies each candidate against Ollama's `GET /api/version`.
- A localhost endpoint is classified as local compute. A LAN endpoint such as `http://192.168.1.50:11434` is classified as remote compute.

This keeps the Windows-desktop-GPU plus MacBook-editing workflow simple: expose Ollama on the Windows machine, connect from the Mac, and keep all file operations local to the Mac workspace.

## Subagents

The first subagent layer is advisory and intentionally small:

| Subagent | Purpose | Tool Access |
|---|---|---|
| Planner | Suggests likely files, order of work, and verification steps | None |
| Reviewer | Calls out risk, missing tests, and platform concerns | None |

Both subagents run as separate model calls before the primary agent starts. Their output is injected as advisory context only; the primary agent must still verify with workspace tools before changing code. This follows the useful part of the opencode `primary` vs `subagent` model without granting background agents write or shell permissions.

## Native App Direction

The target native structure is:

| Layer | Direction |
|---|---|
| Core CLI | Keep the TypeScript/Node agent as the sidecar because it already owns tools, Ollama, and safety boundaries |
| Desktop shell | Use Tauri for macOS and Windows instead of maintaining both Electron and Tauri |
| Connect | Reuse the same Ollama compute endpoint model in CLI and desktop |
| Security | Bind any local control server to loopback only and keep remote model traffic explicit |

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

PatchPilot exposes a `ToolSpec` registry for each tool. Specs describe risk, side effects, permission class, and transcript category. Read-only tools can run in parallel; write and shell-like tools run sequentially and pass through approval when the user has not globally enabled that permission.

Final answer:

```json
{
  "action": "final",
  "message": "The repository is a TypeScript TUI agent..."
}
```

## Sessions

Each TUI launch creates a session id. Events are appended to `.patchpilot/sessions/<session-id>.jsonl` in the workspace:

- `session.created`
- `run.started`
- `model.request`
- `tool.requested`
- `approval.requested`
- `tool.completed`
- `run.completed`
- `run.failed`

The workspace `.patchpilot/` folder is ignored by Git. A global index at `~/.patchpilot/session-index.json` keeps recent sessions discoverable for `patchpilot sessions`, `patchpilot resume`, `/sessions`, and `/resume`.

## Safety

The workspace root is resolved once at startup. Every file path is resolved against that root and rejected if it escapes the workspace. Writes and shell commands are blocked by default. In the TUI, risky tools request approval with allow-once, allow-session, or deny decisions. `--apply` and `--allow-shell` remain explicit compatibility switches for users who want global write or shell permission.

## Telemetry

PatchPilot reads Ollama's non-streaming chat metadata for prompt tokens, response tokens, total duration, and generation speed. Gemini reads API `usageMetadata`. Codex OAuth runs `codex exec --json` and parses the `turn.completed.usage` event, including `cached_input_tokens`, so the TUI can show real Codex CLI usage instead of only character-based estimates.

Model discovery is cached in the current TUI session. Prompt execution reuses the known model list when the selected model is already present, avoiding repeated Gemini model-list calls and keeping Codex/Ollama discovery off the hot path.

The TUI also keeps session-level accounting: request count, prompt tokens, cached prompt tokens, output tokens, total tokens, and estimated cost where public API token pricing is known. Local Ollama cost is reported as zero; Codex OAuth cost is shown as an API-price estimate because actual ChatGPT-plan quota handling is external to PatchPilot.
