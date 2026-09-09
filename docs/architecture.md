# Architecture

PatchPilot is a Node.js 22+ TypeScript ESM application. `src/cli.tsx` owns command-line parsing and launches the Ink UI. The runtime is split into a local-model layer, an agent loop, bounded workspace tools, persistent context/session stores, and multiple terminal renderers.

## Runtime flow

1. CLI and onboarding resolve the workspace, provider, endpoint, model, permissions, and generation limits.
2. `modelClient` creates either an `OllamaClient` or `LocalOpenAIClient`.
3. Capability probing determines native tool-call, JSON-schema, streaming, and context behavior.
4. `AgentRunner` builds the bounded prompt and advertises only the tools allowed in the current mode.
5. The runtime streams visible text, reasoning where exposed, and partial tool-call progress.
6. Tool calls are validated, repaired when safe, loop-checked, approved when required, and executed through `WorkspaceTools`.
7. Events are rendered in the TUI and appended to the session/context stores.

## Main modules

| Module | Responsibility |
|---|---|
| `modelCatalog` / `localRuntimes` | Discover Ollama, LM Studio/Bionic, MLX, llama.cpp, and vLLM models. |
| `ollama` | Ollama chat, model inventory, load state, and model unloading. |
| `localOpenAI` | OpenAI-compatible local chat, streaming, capability probing, and LM Studio/Bionic unloading. |
| `capability` | Choose native tools, constrained JSON, or safe fallback behavior for a model/runtime pair. |
| `agent` | Primary loop, context measurement, tool scheduling, repetition guards, cancellation, and event emission. |
| `toolSchema` / `toolRepair` | Define the nine-tool surface and validate or repair model-emitted calls. |
| `workspace` | Enforce workspace boundaries, secret-path protections, approvals, shell policy, and concrete tool execution. |
| `subagentRunner` | Run bounded `explore` and `general` child loops with isolated context and narrow tool allowlists. |
| `contextStore` / `compaction` | Persist, pin, export, clear, and compact session context. |
| `session` | Append JSONL events and maintain the global session index. |
| `src/tui` | Own commands, state, onboarding, model/host selection, telemetry, and terminal rendering. |

## Local model boundary

`ModelProvider` has exactly two values:

- `ollama` uses Ollama's native API.
- `local-openai` uses an OpenAI-compatible local `/v1` endpoint.

Known local runtimes are described in one registry. Model discovery probes their default ports and ranks usable chat models. MLX and llama.cpp share port 8080, so discovery uses server responses instead of assuming a runtime from its port.

Remote compute is intentionally limited to Ollama inference. `/connect` can select a verified LAN or Tailscale Ollama host, while reads, writes, Git, tests, and shell commands remain on the machine running PatchPilot.

## Agent protocol

PatchPilot advertises nine public tools: `read`, `write`, `edit`, `glob`, `grep`, `bash`, `fetch_url`, `task`, and `todo`.

Native function calling is preferred. When a local model/runtime cannot use it reliably, PatchPilot falls back to a JSON command envelope validated with Zod. Repair handles bounded, unambiguous formatting mistakes; repeated invalid or identical calls stop instead of consuming the remaining step budget.

Context usage is measured against the runtime's effective window. Large tool results are pruned before the model loses the system prompt, and saved context can be compacted while pinned items remain available.

## Child agents

The primary model can issue a `task` call when child agents are enabled or when the user's prompt explicitly requests delegation.

| Type | Tools |
|---|---|
| `explore` | `read`, `glob`, `grep` |
| `general` | `read`, `glob`, `grep`, `write`, `edit` |

Children receive a fresh context, cannot run shell commands, cannot spawn grandchildren, and are capped at eight steps. They run serially to preserve the local runtime's prefix cache. The compact result returns to the parent; the detailed trace is stored under `.patchpilot/subagents/`. Cancellation propagates from the primary run.

## Safety model

- `plan` exposes only read-only tools.
- `build` can request per-action write and shell approval.
- `bypass` skips routine approvals only after explicit trusted-workspace selection.
- Paths are resolved against the workspace and common secret/credential locations are rejected.
- Network retrieval rejects private, loopback, link-local, and cloud-metadata destinations after DNS resolution.
- Shell arguments and metacharacters are classified before execution; high-risk forms retain explicit gates.
- Session approvals are scoped to the concrete action rather than becoming global permission.

## Persistence

Workspace session data lives under `.patchpilot/` and is excluded from release artifacts. Session events are append-only JSONL. A global index under `~/.patchpilot/` supports cross-workspace session listing, while user settings are stored in `~/.patchpilot/.env`.

## Release flow

A signed `v*` tag triggers `.github/workflows/release.yml`. The workflow verifies tag/package version alignment and release notes, installs from the lockfile, runs tests and the build, audits production dependencies and npm signatures, packs the CLI, publishes `@jx-grxf/patchpilot`, and creates the GitHub Release with the tarball.
