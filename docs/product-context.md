# PatchPilot Product Context

PatchPilot is a local-first, permissioned terminal coding agent. It is designed for repository work where the user wants every risky operation to be visible, reviewable, and easy to approve or deny.

## Core Workflow

1. Inspect the workspace with read-only tools.
2. Keep a visible todo list for multi-step work.
3. Propose or apply focused edits in build mode.
4. Request scoped approvals for writes, package scripts, tests, and shell commands.
5. Show Git diff, run checks, and leave commits or pull requests under the user's control.

## Safety Model

- `plan` mode is read-only.
- `build` mode can request approvals for writes and shell actions.
- `bypass` mode removes per-tool approval prompts only after an explicit trusted-workspace confirmation.
- Session approvals are scoped to a concrete target such as a path, script body, patch hash, or normalized shell command.
- Secrets, browser profiles, cookies, and credential files are denied by default.

## TUI Surface

- Header: current provider, model, route, mode, and high-level run state.
- Sidebar: workspace, permissions, machine stats, session telemetry, and advisors.
- Transcript: compact run log, tool results, todos, and live status.
- Composer: bounded multiline prompt editor with visible newest input.
- Command palette: `/models`, `/sessions`, `/connect`, `/doctor`, `/experimental`, and related commands.

## Provider Matrix

- Ollama: local or remote LAN/Tailscale inference.
- Gemini: official Google Gemini API key.
- Gemini-Wrapper: opt-in Gemini Web bridge through pinned `gemini_webapi`; Python bridge supports file analysis, HTTP wrapper mode does not.
- OpenRouter: broad cloud model routing, including free variants.
- NVIDIA: OpenAI-compatible NVIDIA NIM endpoints.
- Codex: ChatGPT login through Codex CLI.

## Useful First Questions

- "What can PatchPilot do in this repo?"
- "Summarize this project and list the safest next fixes."
- "Find the test commands and explain the release process."
- "Review the current diff for risky changes."
