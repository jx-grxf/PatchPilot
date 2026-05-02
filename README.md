<div align="center">

# PatchPilot

**A local-first coding-agent TUI that makes repo changes visible, permissioned, and easy to review.**

[![CI](https://github.com/jx-grxf/PatchPilot/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/jx-grxf/PatchPilot/actions/workflows/ci.yml)
![Status](https://img.shields.io/badge/status-public%20preview-0ea5e9)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)
![Ink](https://img.shields.io/badge/TUI-Ink-111827)
![Ollama](https://img.shields.io/badge/LLM-Ollama-000000)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

<p>
  <strong>Visible tools.</strong> Explicit permissions. Local-first model support. Remote GPU friendly.
</p>

</div>

---

## Showcase

<p align="center">
  <img src="docs/showcase/patchpilot-showcase.svg" alt="PatchPilot terminal interface overview" width="920">
</p>

PatchPilot is a terminal interface for running coding-agent tasks inside a repository. It shows what the agent is doing, keeps risky actions behind explicit permissions, and supports local Ollama, remote Ollama, Gemini, and Codex CLI OAuth backends.

---

## Contents

- [Highlights](#highlights)
- [Why This Exists](#why-this-exists)
- [Quick Start](#quick-start)
- [Usage](#usage)
- [Providers](#providers)
- [Remote Ollama](#remote-ollama)
- [Safety Model](#safety-model)
- [Tech Stack](#tech-stack)
- [Development](#development)
- [Roadmap](#roadmap)
- [Security and Legal](#security-and-legal)
- [License](#license)

## Highlights

| Feature | What it means |
|---|---|
| Local-first by default | Uses Ollama on your own machine unless you choose another provider. |
| Remote GPU workflow | Connect your laptop TUI to an Ollama host on a desktop, LAN, or Tailscale machine. |
| Guided onboarding | First-run setup walks through provider, auth, host discovery, and model choice. |
| Observable agent loop | Transcript, tool calls, telemetry, token counts, cache hits, latency, and cost estimates are visible. |
| Explicit permissions | File writes require `--apply`; shell commands require `--allow-shell`. |
| Workspace boundary | File tools are constrained to the selected project root and block common secret files. |
| Slash-command palette | Type `/` for browsable commands, provider switching, modes, models, diagnostics, and host selection. |
| Advisor subagents | Planner and reviewer calls can brief the main agent before it edits. |
| Multi-provider support | Ollama, Gemini API, and Codex CLI OAuth are supported behind one TUI. |
| CI-ready TypeScript | Strict TypeScript, Vitest, GitHub Actions, and package verification are included. |

## Why This Exists

Most local coding-agent experiments fall into one of two traps: they are either raw scripts that feel painful to use, or polished tools that hide too much of what is happening. PatchPilot aims for the middle: a practical TUI where every file read, search, proposed write, command, and model route stays visible.

The core workflow is intentionally simple:

1. Open a repository.
2. Pick local, remote, or cloud inference.
3. Ask for a patch, review, summary, or refactor plan.
4. Enable writes or shell commands only when the current task needs them.
5. Review the diff before committing.

## Quick Start

PatchPilot is currently a public-preview source install. Clone it, install dependencies, build it, and link the local CLI:

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
patchpilot doctor
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

## Usage

```bash
patchpilot [task] [options]
patchpilot doctor [options]
```

| Option | Description |
|---|---|
| `--workspace <path>` | Project root the agent may inspect. Defaults to the current directory. |
| `--provider <name>` | Model provider: `ollama`, `gemini`, or `codex`. |
| `--model <name>` | Model name for the selected provider. |
| `--ollama-url <url>` | Ollama base URL. Defaults to `http://127.0.0.1:11434`. |
| `--steps <count>` | Maximum agent loop steps before stopping. |
| `--apply` | Allows file writes inside the workspace. |
| `--allow-shell` | Allows shell commands inside the workspace. |
| `--no-subagents` | Disables planner/reviewer advisor calls for faster runs. |

Useful slash commands inside the TUI:

| Command | Description |
|---|---|
| `/help` | Show available commands. |
| `/onboarding` | Open guided provider/auth/model setup. |
| `/mode plan` | Read-only planning mode. |
| `/mode build` | Implementation mode; writes and shell can still be toggled separately. |
| `/write on\|off` | Enable or disable workspace writes. |
| `/shell on\|off` | Enable or disable shell commands. |
| `/agents on\|off` | Enable or disable advisor subagents. |
| `/provider ollama\|gemini\|codex` | Switch inference provider. |
| `/model <name>` | Switch model for the current provider. |
| `/models` | Refresh and browse models. |
| `/connect` | Scan LAN/Tailscale for reachable Ollama hosts. |
| `/connect <url>` | Connect to a specific Ollama host. |
| `/hosts` | Re-scan reachable Ollama hosts. |
| `/doctor` | Run provider diagnostics from inside the TUI. |
| `/clear` | Clear the current transcript. |
| `/exit` | Quit PatchPilot. |

The transcript and sidebar have internal scroll areas. With an empty prompt, use left/right to choose the sidebar or transcript, then Page Up/Page Down and Home/End to navigate long sessions.

## Providers

| Provider | Best for | Setup |
|---|---|---|
| Ollama | Private local coding work and offline experiments. | Install Ollama, pull a model, run `patchpilot`. |
| Remote Ollama | Laptop editing with a stronger desktop/server GPU. | Expose Ollama on the host, then use `/connect` or `--ollama-url`. |
| Gemini | Fast cloud inference through a Gemini API key. | Store `GEMINI_API_KEY` in `~/.patchpilot/config.env` or use onboarding. |
| Codex | Using an existing Codex CLI OAuth login. | Run `codex login`, then `patchpilot --provider codex`. |

Examples:

```bash
patchpilot --provider ollama --model qwen2.5-coder:7b
patchpilot --provider gemini --model gemini-2.5-flash
patchpilot --provider codex --model gpt-5.4
```

Provider diagnostics:

```bash
patchpilot doctor --provider ollama
patchpilot doctor --provider gemini
patchpilot doctor --provider codex
```

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
- Writes are disabled unless `--apply` is set.
- Shell commands are disabled unless `--allow-shell` is set.
- Shell execution uses a restricted single-command runner.
- Provider config is stored in `~/.patchpilot/config.env`, not in the current repository by default.
- Tool output is shown in the transcript and fed back into the agent in clipped form.
- Cloud providers may process prompts and context remotely under their own terms.

This is still experimental agent tooling. Review diffs, avoid sensitive repositories when using cloud providers, and do not enable write or shell permissions casually.

## Tech Stack

| Layer | Technologies |
|---|---|
| Language | TypeScript, strict NodeNext ESM |
| Runtime | Node.js 22+ |
| TUI | Ink, React, ink-text-input |
| Agent protocol | JSON command envelope validated with Zod |
| Providers | Ollama chat API, Gemini generateContent API, Codex CLI OAuth backend |
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
| Permissions | Interactive approve/deny prompts per risky tool call. |
| Agents | Dedicated editor and test-runner roles with hard tool boundaries. |
| Memory | Repository summaries and local task state. |
| Model support | Native Ollama tool calling when model support is reliable. |
| Distribution | Signed macOS and Windows desktop shell with the CLI as a sidecar. |
| Efficiency | More token-cache-aware prompts and provider-specific cost reporting. |

## Security and Legal

PatchPilot can read files, write files, and run shell commands when you enable those capabilities. Use it only in repositories and environments you trust.

- Security reports: please use GitHub Security Advisories or contact the maintainer privately with reproduction steps and impact.
- License: this project is provided under the [MIT License](LICENSE).
- Warranty: the software is provided "AS IS", without warranties of any kind.
- Third-party services: model providers and external services are subject to their own terms, privacy policies, retention settings, and regional compliance requirements.

## License

PatchPilot is released under the [MIT License](LICENSE).
