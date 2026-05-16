<div align="center">

# PatchPilot

**A local-first coding-agent TUI that makes repo changes visible, permissioned, and easy to review across local, remote, and cloud model routes.**

[![CI](https://github.com/jx-grxf/PatchPilot/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/jx-grxf/PatchPilot/actions/workflows/ci.yml)
![Status](https://img.shields.io/badge/status-public%20preview-0ea5e9)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)
![Ink](https://img.shields.io/badge/TUI-Ink-111827)
![Ollama](https://img.shields.io/badge/LLM-Ollama-000000)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

<p>
  <strong>Visible tools.</strong> Explicit permissions. Local Ollama. Remote Ollama. Gemini. OpenRouter. NVIDIA. Codex.
</p>

</div>

---

## Showcase

<p align="center">
  <img src="docs/showcase/patchpilot-showcase.svg" alt="PatchPilot terminal interface overview" width="920">
</p>

PatchPilot is a terminal interface for running coding-agent tasks inside a repository. It shows what the agent is doing, keeps risky actions behind explicit permissions, and supports local Ollama, remote Ollama, Google Gemini, OpenRouter, NVIDIA NIM-compatible endpoints, and Codex CLI OAuth.

---

## Contents

- [Highlights](#highlights)
- [Why This Exists](#why-this-exists)
- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Usage](#usage)
- [Providers](#providers)
- [Remote Ollama](#remote-ollama)
- [Safety Model](#safety-model)
- [Tech Stack](#tech-stack)
- [Development](#development)
- [Roadmap](#roadmap)
- [Release Notes](#release-notes)
- [Security and Legal](#security-and-legal)
- [License](#license)

## Highlights

| Feature | What it means |
|---|---|
| Local-first by default | Uses Ollama on your own machine unless you choose another route. |
| Remote GPU workflow | Connect your laptop TUI to an Ollama host on a desktop, LAN, or Tailscale machine. |
| Cloud provider routes | Gemini, OpenRouter, NVIDIA, and Codex CLI OAuth are available from one TUI. |
| Guided onboarding | First-run setup walks through local/remote mode, provider auth, host discovery, and model choice. |
| Observable agent loop | Transcript, tool calls, telemetry, token counts, provider cache hits, latency, and cost estimates are visible. |
| Explicit permissions | Risky tools request approval unless writes or shell commands are explicitly enabled. |
| Workspace boundary | File tools are constrained to the selected project root and block common secret files. |
| Slash-command palette | Type `/` for browsable commands, provider switching, modes, models, diagnostics, and host selection. |
| Advisor subagents | Explorer, planner, and reviewer advisor calls can brief the main agent before it edits. |
| Ollama eject | `/eject` unloads the active Ollama model; `/eject all` clears models PatchPilot used in the session. |
| CI-ready TypeScript | Strict TypeScript, Vitest, GitHub Actions, and package verification are included. |

## Why This Exists

Most local coding-agent experiments fall into one of two traps: they are either raw scripts that feel painful to use, or polished tools that hide too much of what is happening. PatchPilot aims for the middle: a practical TUI where every file read, search, proposed write, command, model route, and token/cost signal stays visible.

The core workflow is intentionally simple:

1. Open a repository.
2. Pick local, remote, or cloud inference.
3. Ask for a patch, review, summary, or refactor plan.
4. Approve writes or shell commands only when the current task needs them.
5. Review `/diff`, run tests, then commit manually.

Mode behavior is intentionally explicit: `plan` is read-only, `build` keeps writes and shell behind approval prompts, and `build+bypass` enables write and shell permissions only after a visible warning is accepted in the TUI.

## Requirements

| Requirement | Notes |
|---|---|
| Node.js 22 or newer | Required for the published CLI and source builds. |
| Git | Required for repository context and normal development workflows. |
| Ollama | Optional, only needed for local or remote Ollama inference. |
| Provider API key | Optional, only needed for Gemini, OpenRouter, or NVIDIA routes. |
| Codex CLI login | Optional, only needed for the Codex provider route. |

## Quick Start

Install the public CLI globally:

```bash
npm install -g @jx-grxf/patchpilot
```

Verify the installed CLI:

```bash
patchpilot --version
patchpilot doctor --provider ollama
```

For source development, clone it, install dependencies, build it, and link the local CLI:

```bash
git clone https://github.com/jx-grxf/PatchPilot.git
cd PatchPilot
npm install
npm run build
npm link
```

For local Ollama inference:

```bash
ollama pull qwen2.5-coder:7b
patchpilot
```

Then type a task inside the TUI:

```text
summarize this repository and point out the riskiest files
```

For a one-shot task from a different repository:

```bash
cd /path/to/your/project
patchpilot "find likely test gaps in this repo"
```

Use build permissions only when you intentionally want PatchPilot to modify files or run commands:

```bash
patchpilot "add tests for the parser" --apply --allow-shell
```

API keys are stored by onboarding in `~/.patchpilot/.env`.

On first launch, PatchPilot opens guided setup for provider choice, API-key storage, host discovery, and model selection. Press Escape to leave setup, or run `/onboarding` later to reopen it.

## Usage

```bash
patchpilot [task] [options]
patchpilot doctor [options]
patchpilot sessions [--workspace <path>]
patchpilot resume [session-id] [--workspace <path>]
```

| Option | Description |
|---|---|
| `--workspace <path>` | Project root the agent may inspect. Defaults to the current directory. |
| `--provider <name>` | Model provider route. Supports `ollama`, `gemini`/`google`, `openrouter`/`open-router`, `nvidia`/`nim`, and `codex`/`openai`/`openai-codex`. |
| `--model <name>` | Model name for the selected provider. |
| `--ollama-url <url>` | Ollama base URL. Defaults to `http://127.0.0.1:11434`. |
| `--steps <count>` | Maximum agent loop steps before stopping. |
| `--thinking <mode>` | Step-budget mode: `fixed` or `adaptive`. |
| `--reasoning <effort>` | Provider reasoning effort: `none`, `low`, `medium`, `high`, `xhigh`, or `adaptive`. Unsupported provider/model combinations fall back to provider defaults. |
| `--apply` | Allows file writes inside the workspace. |
| `--allow-shell` | Allows shell commands inside the workspace. |
| `--no-subagents` | Disables explorer/planner/reviewer advisor calls for faster runs. |

Useful slash commands inside the TUI:

| Command | Description |
|---|---|
| `/help` | Show available commands. |
| `/help <command>` | Explain one command, for example `/help think` or `/help model`. |
| `/onboarding` | Open guided provider/auth/model setup. |
| `/mode plan` | Read-only planning mode. |
| `/mode build` | Implementation mode; writes and shell can still be toggled separately. |
| `/think fixed\|adaptive` | Switch between fixed and adaptive step budgets. |
| `/reasoning none\|low\|medium\|high\|xhigh\|adaptive` | Set provider reasoning effort where supported. |
| `/write on\|off` | Enable or disable workspace writes. |
| `/shell on\|off` | Enable or disable shell commands. |
| `/agents on\|off` | Enable or disable advisor subagents. |
| `/provider ollama\|gemini\|openrouter\|nvidia\|codex` | Switch inference provider. |
| `/model <query>` | Search and switch the model for the current provider. |
| `/models [query\|number]` | Refresh, search, browse, or select provider models. |
| `/connect` | Scan LAN/Tailscale for reachable Ollama hosts. |
| `/connect <url>` | Connect to a specific Ollama host. |
| `/eject [model\|all]` | Unload Ollama model(s) from the active host. |
| `/hosts` | Re-scan reachable Ollama hosts. |
| `/doctor` | Run provider diagnostics from inside the TUI. |
| `/sessions` | List recent sessions for the current workspace. |
| `/resume [session-id]` | Load a previous session summary. |
| `/diff` | Show the current Git diff. |
| `/approve once\|session` | Approve a pending risky tool request. |
| `/deny` | Deny a pending risky tool request. |
| `/clear` | Clear the current transcript. |
| `/exit` | Quit PatchPilot. |

The transcript and sidebar have internal scroll areas. With an empty prompt, use left/right to choose the sidebar or transcript, then Page Up/Page Down and Home/End to navigate long sessions.

## Providers

| Provider route | Accepted values | Default model | Best for | Setup |
|---|---|---|---|---|
| Ollama local | `ollama` | `qwen2.5-coder:7b` | Private local coding work and offline experiments. | Install Ollama, pull a model, run `patchpilot`. |
| Ollama remote | `ollama` with `--ollama-url` or `/connect` | Host model inventory | Laptop editing with a stronger desktop/server GPU. | Expose Ollama on the host, then use `/connect` or `--ollama-url`. |
| Google Gemini | `gemini`, `google` | `gemini-2.5-flash` | Fast cloud inference through a Gemini API key. | Store `GEMINI_API_KEY` in `~/.patchpilot/.env` or use onboarding. |
| OpenRouter | `openrouter`, `open-router` | `openrouter/auto` | Broad model routing, auto model selection, and free variants. | Store `OPENROUTER_API_KEY` in `~/.patchpilot/.env` or use onboarding. |
| NVIDIA | `nvidia`, `nim` | `meta/llama-3.1-70b-instruct` | NVIDIA NIM OpenAI-compatible endpoints. | Store `NVIDIA_API_KEY` in `~/.patchpilot/.env` or use onboarding. |
| Codex CLI | `codex`, `openai`, `openai-codex` | `gpt-5.5` | Using an existing Codex CLI OAuth login. | Run `codex login`, then `patchpilot --provider codex`. |

Examples:

```bash
patchpilot --provider ollama --model qwen2.5-coder:7b
patchpilot --provider gemini --model gemini-2.5-flash
patchpilot --provider openrouter --model openrouter/auto
patchpilot --provider nvidia --model meta/llama-3.1-70b-instruct
patchpilot --provider codex --model gpt-5.5
patchpilot --provider google --model gemini-2.5-flash
patchpilot --provider nim --model meta/llama-3.1-70b-instruct
patchpilot --provider openai --model gpt-5.5
```

Provider diagnostics:

```bash
patchpilot doctor --provider ollama
patchpilot doctor --provider gemini
patchpilot doctor --provider openrouter
patchpilot doctor --provider nvidia
patchpilot doctor --provider codex
```

PatchPilot caches model discovery for a short TTL inside the running TUI, so normal prompts do not re-query providers every time. Run `/models` again when you intentionally want to refresh the visible list.

PatchPilot reads provider cache telemetry when the provider reports it, for example Codex cached input tokens or OpenRouter `prompt_tokens_details.cached_tokens`, then displays cache hit rate as `cached / input`.

Reasoning support is provider and model dependent. Codex accepts fixed reasoning levels. OpenRouter receives normalized `reasoning.effort` for compatible models. Gemini uses Thinking configuration where the selected model exposes it; some Gemini models cannot disable thinking. Ollama only receives native `think` values for known thinking model families. NVIDIA reasoning effort is limited to supported GPT-OSS NIM routes.

OpenRouter `:free` models are rate-limited by OpenRouter. PatchPilot warns when a selected model ID ends in `:free`.

## Remote Ollama

PatchPilot can run the TUI and workspace tools on one machine while sending model requests to Ollama on another machine. This is useful when your desktop has the GPU and your laptop is where you edit code.

Inside PatchPilot:

```text
/connect
/connect 1
/connect http://192.168.1.50:11434
/connect local
```

From the shell:

```bash
patchpilot --ollama-url http://<host-ip>:11434
```

On a Windows desktop or remote host, expose Ollama on your private network:

1. Quit Ollama.
2. Set `OLLAMA_HOST` to `0.0.0.0:11434`.
3. Start Ollama again.
4. Allow inbound TCP traffic on port `11434` only on trusted private networks.

PatchPilot verifies candidates with Ollama's `/api/version` endpoint before listing them. It does not move file reads, writes, Git, or test commands to the remote host; only model requests are routed there.

For smaller local machines, reduce the request budget before starting PatchPilot:

```bash
PATCHPILOT_NUM_CTX=4096 PATCHPILOT_NUM_PREDICT=768 patchpilot
```

## Safety Model

PatchPilot is designed to keep powerful actions boring and reviewable:

- File access is constrained to one workspace root.
- Secret-like files such as `.env`, `.npmrc`, SSH keys, and `.netrc` are blocked from normal file tools.
- Writes are blocked by default; in the TUI, risky write tools request approval, and `--apply` keeps the legacy always-allow write path.
- Shell commands are blocked by default; dedicated script/test tools request approval, and `--allow-shell` keeps the legacy always-allow shell path.
- Shell execution uses a restricted single-command runner.
- Provider config is stored in `~/.patchpilot/.env`, not in the current repository by default.
- Session logs are stored as append-only JSONL in `.patchpilot/sessions/`; that folder is gitignored. A global index in `~/.patchpilot/session-index.json` powers `patchpilot sessions` and `/resume`.
- Tool output is shown in the transcript and fed back into the agent in clipped form.
- Cloud providers may process prompts and context remotely under their own terms.

This is still experimental agent tooling. Review diffs, avoid sensitive repositories when using cloud providers, and do not enable write or shell permissions casually.

Safe patch workflow:

```text
/mode plan
ask PatchPilot to inspect and propose the change
/mode build
approve only the specific write/test requests you expect
/diff
run tests
commit manually with git
```

PatchPilot now has approval prompts and a Git diff command, but it still does not replace human review. Inline rich diff review and commit/PR automation remain future work.

## Tech Stack

| Layer | Technologies |
|---|---|
| Language | TypeScript, strict NodeNext ESM |
| Runtime | Node.js 22+ |
| TUI | Ink, React, ink-text-input |
| Agent protocol | JSON command envelope validated with Zod |
| Sessions | Append-only JSONL in `.patchpilot/sessions` plus global index in `~/.patchpilot` |
| Providers | Ollama chat API, Gemini generateContent API, OpenRouter OpenAI-compatible API, NVIDIA OpenAI-compatible API, Codex CLI OAuth backend |
| Tests | Vitest |
| CI | GitHub Actions |

More detail: [docs/architecture.md](docs/architecture.md)

## Development

Run the TUI from source:

```bash
npm run dev -- "summarize this repository"
```

Typecheck, test, and build:

```bash
npm run typecheck
npm test
npm run build
```

If Vitest fails because a native optional dependency was installed incorrectly, run `npm ci` again before debugging PatchPilot itself.

## Roadmap

| Area | Planned work |
|---|---|
| Patch review | Rich diff preview before writes. |
| Permissions | Per-tool approval exists; richer previews and persisted policies are next. |
| Agents | Dedicated editor and test-runner roles with hard tool boundaries. |
| Memory | Deeper resume that restores full transcript context, not just session summaries. |
| Model support | Native Ollama tool calling when model support is reliable. |
| Distribution | Signed macOS and Windows desktop shell with the CLI as a sidecar. |
| Efficiency | More token-cache-aware prompts and provider-specific cost reporting. |

## Release Notes

Release notes are kept in [docs/releases](docs/releases).

| Version | Notes |
|---|---|
| `v0.3.1-beta` | [Release notes](docs/releases/v0.3.1-beta.md) |
| `v0.3.0` | [Release notes](docs/releases/v0.3.0.md) |
| `v0.2.1` | [Release notes](docs/releases/v0.2.1.md) |
| `v0.2.0` | [Release notes](docs/releases/v0.2.0.md) |
| `v0.1.0` | [Release notes](docs/releases/v0.1.0.md) |

## Security and Legal

PatchPilot can read files, write files, and run shell commands when you enable those capabilities. Use it only in repositories and environments you trust.

- Security policy: see [SECURITY.md](SECURITY.md).
- Security reports: please use GitHub Security Advisories or contact the maintainer privately with reproduction steps and impact.
- License: this project is provided under the [MIT License](LICENSE).
- Warranty: the software is provided "AS IS", without warranties of any kind.
- Third-party services: model providers and external services are subject to their own terms, privacy policies, retention settings, and regional compliance requirements.

## License

PatchPilot is released under the [MIT License](LICENSE).
