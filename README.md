<div align="center">

# PatchPilot

**A local-first coding agent TUI for editing, testing, and preparing patches with Ollama.**

[![CI](https://github.com/jx-grxf/PatchPilot/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/jx-grxf/PatchPilot/actions/workflows/ci.yml)
![Status](https://img.shields.io/badge/status-early%20prototype-f59e0b)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)
![Ink](https://img.shields.io/badge/TUI-Ink-111827)
![Ollama](https://img.shields.io/badge/LLM-Ollama-000000)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

</div>

PatchPilot is a terminal coding assistant designed around local models, visible tool execution, and a clean patch-oriented workflow. It starts small on purpose: one agent, one workspace boundary, explicit write and shell permissions, and an interface that makes every step observable.

The project is private while it is incubating, but the repository structure, documentation, and workflow are prepared for a public open-source release.

---

## Showcase

<p align="center">
  <img src="docs/showcase/patchpilot-showcase.svg" alt="PatchPilot terminal interface overview" width="920">
</p>

---

## Contents

- [Highlights](#highlights)
- [Why This Exists](#why-this-exists)
- [Current Workflow](#current-workflow)
- [Tech Stack](#tech-stack)
- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Usage](#usage)
- [Safety Model](#safety-model)
- [Development](#development)
- [Roadmap](#roadmap)
- [License](#license)

---

## Highlights

| Feature | Description |
|---|---|
| Local-first agent | Talks to an Ollama server running on your machine by default |
| Gemini API provider | Can switch to Gemini through `GEMINI_API_KEY` in `.env` |
| Codex OAuth provider | Can use your ChatGPT Plus/Pro Codex CLI login through `codex exec` |
| TUI workflow | Ink-powered terminal UI with status, transcript, provider, model, and workspace context |
| Workspace boundary | File tools refuse to read or write outside the selected project root |
| Explicit permissions | Writes require `--apply`; shell execution requires `--allow-shell` |
| Runtime telemetry | Header shows CPU, memory, GPU, VRAM, temperature, power, live prompt tokens, request tokens, cache hits, estimated session cost, generation speed, and latency |
| Remote Ollama | `/connect` scans the LAN and only lists hosts that answer Ollama's `/api/version` endpoint |
| Compute target awareness | The TUI marks Ollama as local/remote and Gemini/Codex as cloud inference |
| Advisor subagents | Planner and reviewer subagents give the primary agent a short tactical brief before it starts |
| Tool-visible loop | The model can list files, read files, search text, write files, and run commands |
| JSON agent protocol | Model responses are parsed through a typed command envelope |
| CI-ready repo | TypeScript build, tests, and GitHub Actions are included from day one |

## Why This Exists

Local LLMs are useful for coding, but most local agent experiments either feel like raw scripts or hide too much of what is happening. PatchPilot aims for the middle ground: a polished TUI that stays honest about every file read, write, search, and command.

The first target is a practical developer workflow: open a repository, describe the patch, let the local model inspect context, and keep the user in control of risky actions.

## Current Workflow

1. Start Ollama and pull a coding model such as `qwen2.5-coder:7b`.
2. Open a project directory.
3. Run PatchPilot with a task prompt.
4. Watch the agent inspect files and request tools.
5. Enable writes or shell commands only when you intentionally want them.
6. Review the resulting Git diff before committing.

---

## Tech Stack

| Layer | Technologies |
|---|---|
| Language | TypeScript, strict NodeNext ESM |
| Runtime | Node.js 22 or newer |
| TUI | Ink, React, ink-text-input |
| Agent protocol | JSON command envelope validated with Zod |
| Model providers | Ollama chat API, Gemini generateContent API, Codex CLI OAuth backend with JSON usage telemetry |
| Tests | Vitest |
| CI | GitHub Actions |

## Requirements

- Node.js 22 or newer
- npm 10 or newer
- Git
- Ollama for local or remote model execution, a Gemini API key, or Codex CLI login
- A pulled local model, for example `qwen2.5-coder:7b`, `GEMINI_API_KEY` in `.env`, or `codex login`

---

## Quick Start

Install dependencies:

```bash
npm install
```

Start Ollama and pull a model:

```bash
ollama pull qwen2.5-coder:7b
```

Or use Gemini through `.env`:

```bash
cp .env.example .env
```

Then set `GEMINI_API_KEY` in `.env`.

Or use Codex OAuth through your ChatGPT plan:

```bash
codex login
patchpilot --provider codex --model gpt-5.4
```

Run PatchPilot in a repository:

```bash
patchpilot
```

Then type normal tasks directly into the TUI:

```text
summarize this repository
```

Use slash commands inside the TUI:

```text
/help
/onboarding
/mode build
/write on
/shell on
/provider gemini
/provider codex
/model uncensored
/connect http://192.168.1.50:11434
/doctor
```

## Usage

```bash
patchpilot [task] [options]
```

| Option | Description |
|---|---|
| `--workspace <path>` | Project root the agent may inspect |
| `--provider <name>` | Model provider: `ollama`, `gemini`, or `codex` |
| `--model <name>` | Model name, defaults to `qwen2.5-coder:7b`, `gemini-2.5-flash`, or `gpt-5.4` |
| `--ollama-url <url>` | Ollama base URL, defaults to `http://127.0.0.1:11434` |
| `--steps <count>` | Maximum agent steps before stopping |
| `--apply` | Allows file writes inside the workspace |
| `--allow-shell` | Allows shell commands inside the workspace |
| `--no-subagents` | Disables planner/reviewer advisor calls for faster local runs |

Run diagnostics:

```bash
patchpilot doctor
```

The doctor command checks Node, Git, and the active provider. For Ollama, it checks the Ollama CLI/server and whether the selected model is pulled locally. For Gemini, it checks `GEMINI_API_KEY`, the models API, and whether the selected model is listed. For Codex, it checks the Codex CLI and your local ChatGPT OAuth login. Use `patchpilot doctor --provider codex` when testing Codex OAuth.

PatchPilot caches the last model list inside the TUI session, so normal prompts do not re-query Gemini/Ollama/Codex model discovery every time. Run `/models` again when you intentionally want to refresh the visible list.

Inside the TUI, use `/help` to see available commands. Permissions can be changed without restarting:

The transcript and session sidebar have internal scroll windows. With an empty prompt, use left/right to choose the sidebar or transcript, then Page Up/Page Down to scroll and Home/End to jump.

| Slash command | Description |
|---|---|
| `/help` | Show available commands |
| `/` | Show command suggestions while typing |
| `/onboarding` | Choose provider, save a Gemini API key, connect Codex OAuth, and select a model |
| `/permissions` | Show current write and shell permissions |
| `/agents on\|off` | Enable or disable planner/reviewer advisor subagents |
| `/provider ollama\|gemini\|codex` | Switch between Ollama, Gemini API, and Codex OAuth inference |
| `/mode plan` | Read-only planning mode |
| `/mode build` | Implementation mode; writes and shell can be enabled |
| `/plan` | Shortcut for `/mode plan` |
| `/build` | Shortcut for `/mode build` |
| `/write on\|off` | Enable or disable workspace writes |
| `/shell on\|off` | Enable or disable shell commands |
| `/model <name>` | Switch the model for the current provider |
| `/models` | List models for the current provider |
| `/models <number>` | Select a model from the last `/models` list |
| `/model uncensored` | Switch to `huihui_ai/qwen2.5-coder-abliterate:7b` |
| `/model default` | Switch back to `qwen2.5-coder:7b` |
| `/connect` | Auto-scan the LAN for reachable Ollama servers |
| `/connect <url>` | Connect to another Ollama host for the current session |
| `/connect <number>` | Connect to a numbered host from the `/connect` list |
| `/connect local` | Switch back to local Ollama at `127.0.0.1:11434` on non-macOS clients |
| `/hosts` | Re-scan reachable Ollama hosts |
| `/doctor` | Check Node, Git, and the active provider from inside the TUI |
| `/clear` | Clear the current transcript |
| `/exit` | Quit PatchPilot |

## Remote Ollama

PatchPilot can run the agent on one machine while using an Ollama server on another machine. This is useful when your Windows desktop has the GPU and your MacBook is where you are editing code.

By default, PatchPilot talks to Ollama at `http://127.0.0.1:11434` on macOS, Windows, and Linux. On macOS, install and start Ollama.app, pull a model, then run PatchPilot directly:

```bash
ollama pull qwen2.5-coder:7b
patchpilot
```

PatchPilot keeps file reads, file writes, shell commands, Git, and tests on the machine where the TUI runs. Only model requests go to the selected Ollama server.

When connected to a remote Ollama server, `patchpilot doctor` treats the local Ollama CLI as optional because the selected compute target is another machine. Node.js and Git are still checked locally because workspace tools still run on the client.

For Apple Silicon Macs with less memory, tune the request budget before starting PatchPilot:

```bash
PATCHPILOT_NUM_CTX=4096 PATCHPILOT_NUM_PREDICT=768 patchpilot
```

To use a stronger remote GPU host from the MacBook, switch inside the TUI:

```text
/connect
/connect 1
```

On a Windows desktop or another remote machine, expose Ollama on the LAN:

1. Quit Ollama from the taskbar.
2. Add a user environment variable named `OLLAMA_HOST` with value `0.0.0.0:11434`.
3. Start Ollama again from the Start menu.
4. Allow inbound TCP traffic on port `11434` in the Windows firewall for your private network.

From the MacBook, run PatchPilot inside the project you want to edit and connect to the desktop:

```bash
patchpilot --ollama-url http://<windows-pc-ip>:11434
```

Or switch inside the TUI from any supported platform:

```text
/connect
/connect 1
/connect http://<windows-pc-ip>:11434
/connect local
```

The scan verifies `GET /api/version`, so it does not list random local interfaces or machines that merely have port `11434` open.

## Safety Model

PatchPilot is designed to make local execution boring in the best way:

- File access is constrained to a single workspace root.
- Write tools are disabled unless `--apply` is set.
- Shell tools are disabled unless `--allow-shell` is set.
- Shell commands run with timeouts.
- Tool output is fed back into the agent instead of hidden from the user.
- The TUI surfaces CPU, memory, GPU utilization, VRAM, temperature, power draw, live prompt tokens, token counts, Codex cache hits, estimated session cost, token throughput, and request latency.

Codex OAuth runs `codex exec --json` and reads the CLI's `turn.completed.usage` event, including cached input tokens. Session cost is an estimate based on public API token pricing where available; actual ChatGPT-plan quota behavior is controlled by Codex/ChatGPT plan limits.

This does not make local agents harmless. Review diffs before committing, especially when using small local models.

## Development

Run the development TUI:

```bash
npm run dev -- "summarize this repository"
```

Typecheck:

```bash
npm run typecheck
```

Run tests:

```bash
npm test
```

Build:

```bash
npm run build
```

## Roadmap

| Area | Planned Work |
|---|---|
| Patch review | Rich diff preview before writes |
| Permissions | Interactive approve/deny prompts per risky tool call |
| Agents | Dedicated editor and test-runner roles with hard tool boundaries |
| Memory | Repository summaries and local task state |
| Model support | Native Ollama tool-calling when model support is reliable |
| Distribution | Tauri shell with PatchPilot CLI sidecar for signed macOS and Windows releases |

## License

PatchPilot is released under the [MIT License](LICENSE).
