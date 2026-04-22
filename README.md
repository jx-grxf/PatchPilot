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
| Local-first agent | Talks to an Ollama server running on your machine |
| TUI workflow | Ink-powered terminal UI with status, transcript, model, and workspace context |
| Workspace boundary | File tools refuse to read or write outside the selected project root |
| Explicit permissions | Writes require `--apply`; shell execution requires `--allow-shell` |
| Runtime telemetry | Header shows CPU, memory, GPU, VRAM, temperature, power, request tokens, generation speed, and latency |
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
| Local LLM | Ollama chat API |
| Tests | Vitest |
| CI | GitHub Actions |

## Requirements

- Node.js 22 or newer
- npm 10 or newer
- Git
- Ollama for local model execution
- A pulled local model, for example `qwen2.5-coder:7b`

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
/write on
/shell on
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
| `--model <name>` | Ollama model name, defaults to `qwen2.5-coder:7b` |
| `--ollama-url <url>` | Ollama base URL, defaults to `http://127.0.0.1:11434` |
| `--steps <count>` | Maximum agent steps before stopping |
| `--apply` | Allows file writes inside the workspace |
| `--allow-shell` | Allows shell commands inside the workspace |

Run diagnostics:

```bash
patchpilot doctor
```

Inside the TUI, use `/help` to see available commands. Permissions can be changed without restarting:

| Slash command | Description |
|---|---|
| `/help` | Show available commands |
| `/permissions` | Show current write and shell permissions |
| `/write on\|off` | Enable or disable workspace writes |
| `/shell on\|off` | Enable or disable shell commands |
| `/model <name>` | Switch the Ollama model for the current session |
| `/model uncensored` | Switch to `huihui_ai/qwen2.5-coder-abliterate:7b` |
| `/model default` | Switch back to `qwen2.5-coder:7b` |
| `/connect <url>` | Connect to another Ollama host for the current session |
| `/connect local` | Switch back to local Ollama at `127.0.0.1:11434` |
| `/doctor` | Check Node, Git, and Ollama from inside the TUI |
| `/clear` | Clear the current transcript |
| `/exit` | Quit PatchPilot |

## Remote Ollama

PatchPilot can run the agent on one machine while using an Ollama server on another machine. This is useful when your Windows desktop has the GPU and your MacBook is where you are editing code.

On the Windows desktop, expose Ollama on the LAN:

1. Quit Ollama from the taskbar.
2. Add a user environment variable named `OLLAMA_HOST` with value `0.0.0.0:11434`.
3. Start Ollama again from the Start menu.
4. Allow inbound TCP traffic on port `11434` in the Windows firewall for your private network.

From the MacBook, run PatchPilot inside the project you want to edit and connect to the desktop:

```bash
patchpilot --ollama-url http://<windows-pc-ip>:11434
```

Or switch inside the TUI:

```text
/connect http://<windows-pc-ip>:11434
```

The files and shell commands still run on the MacBook. Only model inference runs on the Windows desktop.

## Safety Model

PatchPilot is designed to make local execution boring in the best way:

- File access is constrained to a single workspace root.
- Write tools are disabled unless `--apply` is set.
- Shell tools are disabled unless `--allow-shell` is set.
- Shell commands run with timeouts.
- Tool output is fed back into the agent instead of hidden from the user.
- The TUI surfaces CPU, memory, GPU utilization, VRAM, temperature, power draw, token counts, token throughput, and request latency.

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
| Agents | Planner, editor, reviewer, and test-runner roles |
| Memory | Repository summaries and local task state |
| Model support | Native Ollama tool-calling when model support is reliable |
| Distribution | Signed releases for Windows, macOS, and Linux |

## License

PatchPilot is released under the [MIT License](LICENSE).
