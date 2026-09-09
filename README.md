# PatchPilot

PatchPilot is a local-only coding-agent TUI for repository work. It runs the model on infrastructure you control, keeps file and shell actions visible, and gives you explicit control over every risky operation.

[![CI](https://github.com/jx-grxf/PatchPilot/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/jx-grxf/PatchPilot/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@jx-grxf/patchpilot)](https://www.npmjs.com/package/@jx-grxf/patchpilot)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

PatchPilot 2.0 removes the cloud-provider integrations from the 1.x line and focuses on making local models reliable: native tool calling with a repair fallback, streaming output, context pressure controls, real child agents, a compact terminal shell, and model discovery across common local runtimes.

## What it supports

- Ollama on the current machine, LAN, or Tailscale.
- OpenAI-compatible local endpoints from LM Studio/Bionic, MLX, llama.cpp, and vLLM.
- Native function calling when the runtime supports it, with a validated JSON-envelope fallback.
- Nine focused agent tools for reading, searching, editing, shell work, public URL retrieval, todos, and child-agent delegation.
- `plan`, `build`, and `bypass` modes with workspace boundaries and scoped approvals.
- Streaming answers, tool-argument progress, model throughput, context pressure, token totals, and local-vs-hosted cost estimates.
- Persistent JSONL sessions, resumable summaries, context pinning/compaction, prompt history, and session recaps.
- Isolated `explore` and `general` child agents with bounded steps and narrow tool allowlists.
- Model discovery, selection, and unloading across supported local runtimes.
- Flow, fullscreen, and legacy terminal layouts with reduced-motion support.

All file and shell tools still run on the machine where PatchPilot is launched. Connecting to a remote Ollama host moves only model inference.

## Requirements

- Node.js 22 or newer.
- Git.
- At least one running model runtime:
  - [Ollama](https://ollama.com/), or
  - an OpenAI-compatible local server such as LM Studio/Bionic, MLX, llama.cpp, or vLLM.

No cloud-model account or provider API key is required. `PATCHPILOT_LOCAL_API_KEY` exists only for local endpoints that you configured to require authentication.

## Install

```bash
npm install -g @jx-grxf/patchpilot
patchpilot --version
```

Start a model, then launch PatchPilot inside a repository:

```bash
ollama pull qwen2.5-coder:7b
cd /path/to/repository
patchpilot
```

You can also provide the first task directly:

```bash
patchpilot "inspect this repository and identify the riskiest untested path"
```

First launch opens guided setup. Run `/onboarding` at any time to select a runtime, endpoint, model, default mode, and child-agent preference.

## Local runtimes

| Runtime | Provider value | Default endpoint |
|---|---|---|
| Ollama | `ollama` | `http://127.0.0.1:11434` |
| LM Studio / Bionic | `local-openai` | `http://127.0.0.1:1234/v1` |
| MLX | `local-openai` | `http://127.0.0.1:8080/v1` |
| llama.cpp | `local-openai` | `http://127.0.0.1:8080/v1` |
| vLLM | `local-openai` | `http://127.0.0.1:8000/v1` |

Discover every reachable runtime and usable model:

```bash
patchpilot models
patchpilot models --json
```

Examples:

```bash
patchpilot --provider ollama --model devstral:24b
PATCHPILOT_LOCAL_URL=http://127.0.0.1:1234/v1 \
  patchpilot --provider local-openai --model qwen3-coder-30b
```

For remote Ollama inference:

```bash
patchpilot --provider ollama \
  --ollama-url http://192.168.1.50:11434 \
  --model qwen3-coder:30b
```

Inside the TUI, `/connect` scans remembered, LAN, and reachable Tailscale candidates. `/connect local` returns to localhost. PatchPilot verifies Ollama candidates before listing them.

## CLI

```text
patchpilot [task...] [options]
patchpilot init [--workspace <path>]
patchpilot cleanup [cache|sessions|temp|all] [--workspace <path>]
patchpilot doctor [options]
patchpilot models [--all] [--json]
patchpilot sessions [--workspace <path>]
patchpilot resume [session-id] [--workspace <path>]
```

Important run options:

| Option | Meaning |
|---|---|
| `--workspace <path>` | Workspace root; defaults to the current directory. |
| `--provider ollama\|local-openai` | Select the local model protocol. |
| `--model <name>` | Select the runtime model. |
| `--ollama-url <url>` | Select a local or remote Ollama endpoint. |
| `--steps <count>` | Maximum primary-agent steps. |
| `--apply` | Start with workspace writes enabled. |
| `--allow-shell` | Start with shell execution enabled. |
| `--subagents` | Enable isolated child-agent delegation. |

`--apply --allow-shell` starts in bypass mode. Use it only for a trusted workspace; high-risk shell syntax can still require confirmation.

## TUI commands

Type `/` to browse the complete command palette. Common commands are:

| Command | Meaning |
|---|---|
| `/mode plan\|build\|bypass` | Switch permission mode. `Tab` cycles the same modes. |
| `/provider ollama\|local-openai` | Switch the model protocol. |
| `/models [query\|number]` | Refresh, search, or select models. |
| `/connect [host\|local]` | Select an Ollama compute host. |
| `/eject [model\|all]` | Unload Ollama or LM Studio/Bionic model instances. |
| `/agents on\|off` | Toggle child-agent delegation. |
| `/config` and `/set` | Inspect or change persisted runtime settings. |
| `/context ...` and `/compact ...` | Inspect, pin, export, clear, or compact session context. |
| `/status` and `/usage` | Show runtime, permission, token, tool, and savings telemetry. |
| `/diff` | Show the current Git diff. |
| `/sessions`, `/resume`, `/recap`, `/new` | Manage local sessions. |
| `/doctor` | Check Node, Git, endpoint, and selected-model readiness. |
| `/update` | Check npm/GitHub and offer to install an exact newer release. |
| `/experimental` | Configure file analysis, memory, child agents, and shell metacharacters. |
| `/theme` | Choose the flow, fullscreen, or legacy interface. |

Press `Esc` to stop a running task. The flow shell keeps transcript output in normal terminal scrollback; the fullscreen and legacy layouts keep bounded internal scroll regions.

## Safety model

- `plan` advertises only read-only tools.
- `build` exposes editing and shell tools but requests approval before side effects.
- `bypass` allows configured writes and shell commands without routine per-call approval.
- File operations are constrained to the selected workspace.
- Common secret and credential paths are denied by default.
- Public URL fetching blocks loopback, LAN, link-local, and cloud-metadata targets, including DNS resolutions into those ranges.
- Child agents cannot spawn grandchildren or use shell commands. `explore` is read-only; `general` can use bounded file edits.
- Aborting a run propagates to the active model request and child agent before sibling writes continue.

Review the diff and test the result before committing generated changes. See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Configuration

Guided setup and `/set` persist runtime configuration in `~/.patchpilot/.env`. The repository's [.env.example](.env.example) documents supported variables.

The most important values are:

```dotenv
PATCHPILOT_PROVIDER=ollama
PATCHPILOT_MODEL=qwen2.5-coder:7b
PATCHPILOT_OLLAMA_URL=http://127.0.0.1:11434
PATCHPILOT_LOCAL_URL=http://127.0.0.1:1234/v1
PATCHPILOT_NUM_CTX=32768
PATCHPILOT_NUM_PREDICT=16384
PATCHPILOT_DEFAULT_MODE=build
PATCHPILOT_SUBAGENTS=0
```

Thinking stays with the selected model and runtime. PatchPilot detects known thinking-capable model families but does not expose a manual reasoning-effort command.

## Development

```bash
npm ci
npm run dev -- "summarize this repository"
npm run typecheck
npm test
npm run build
npm audit --omit=dev --audit-level=moderate
npm audit signatures
npm pack --dry-run
```

The project uses strict TypeScript with NodeNext ESM, React/Ink for the TUI, Zod at protocol boundaries, and Vitest for tests. Build output goes to `dist/` and is not committed.

Architecture details live in [docs/architecture.md](docs/architecture.md). Product invariants live in [docs/product-context.md](docs/product-context.md).

## Releases

Release notes are in [docs/releases](docs/releases). The current release is [v2.0.1](docs/releases/v2.0.1.md).

A signed `v*` tag triggers CI verification, npm publication, package creation, and the GitHub Release workflow.

## License

PatchPilot is released under the [MIT License](LICENSE).
