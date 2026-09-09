# PatchPilot Product Context

PatchPilot is a local-only, permissioned terminal coding agent. It is for repository work where the user wants model inference on infrastructure they control and every risky tool action to remain visible and reviewable.

## Product invariants

- Supported model routes are Ollama and OpenAI-compatible local runtimes only.
- Remote Ollama moves inference, never workspace tools.
- `plan` is read-only, `build` asks before side effects, and `bypass` is an explicit trusted-workspace choice.
- Workspace boundaries, secret-path protections, and high-risk shell checks must survive every UI or tool refactor.
- Native tool calling is preferred, but weaker local models must have a validated fallback and bounded repair path.
- Cancellation is a normal outcome and must stop active model/child work before further writes continue.
- Long sessions must expose context pressure and retain pinned context through compaction.
- Child agents have isolated context, bounded steps, narrow tools, no shell, and no recursive delegation.
- UI telemetry must describe real runtime state; local OpenAI-compatible endpoints must never be labeled as cloud compute.

## Core workflow

1. Select a repository and a reachable local model runtime.
2. Inspect with read-only tools and keep multi-step work visible through todos.
3. Request or apply focused edits according to the active permission mode.
4. Run checks through the bounded shell path.
5. Inspect the diff and report verified outcomes, failures, and remaining gates.

## Interface

- Header: runtime, model, compute route, mode, context pressure, and current work state.
- Transcript: streaming output, reasoning where available, tool calls/results, todos, and failures.
- Composer: multiline prompt editing, history, slash-command completion, and attachments.
- Status/config surfaces: settings, permissions, runtime health, model inventory, token/tool telemetry, and child-agent state.
- Session surfaces: new, list, resume, recap, context inspection, export, pinning, and compaction.

## Supported runtimes

- Ollama, locally or on a verified LAN/Tailscale host.
- LM Studio and Bionic through their local OpenAI-compatible server.
- MLX on Apple Silicon.
- llama.cpp.
- vLLM.

## Useful first tasks

- "Summarize this repository and identify the highest-risk untested path."
- "Review the current diff and explain the smallest safe fix."
- "Find the build and test commands, then verify the current change."
- "Delegate repository exploration to a child agent and return only the relevant files."
