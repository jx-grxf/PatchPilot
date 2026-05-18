# PatchPilot Developer Agent Guidance

This repository contains PatchPilot, a local-first coding agent TUI built with Node.js, TypeScript, and Ink.

## Development Workflow & Commands

Always use the existing npm scripts for building, testing, and verifying changes:
* **Run Development TUI**: `npm run dev` (uses `tsx` to run `src/cli.tsx` directly)
* **Run Tests**: `npm test` (runs Vitest unit tests suite)
* **Typecheck Code**: `npm run typecheck` (runs `tsc --noEmit` to verify TypeScript safety)
* **Build Project**: `npm run build` (cleans the output directory and compiles code via `tsc` to `dist/`)
* **Clean Build Artifacts**: `npm run clean` (removes the `dist/` folder)

## Architecture & Component Breakdown

* `src/core/`: Contains the headless core logic, client classes, and agent coordination mechanisms.
    * `AgentRunner.ts`: Controls the primary execution loop, tool selection, work state, and event dispatch.
    * `WorkspaceTools.ts`: Provides bounded OS and file system interactions (file read/write, patches, git, shell execution).
    * `compute.ts`: Evaluates whether target compute is local or remote LAN/Tailscale.
    * `subagents.ts`: Contains advisory-only Planner and Reviewer pre-loops (they do not receive tool permissions).
    * `projectInit.ts`: Implements repository initialization workflows (including this file's generation template).
* `src/tui/`: Contains UI layout, terminal rendering, and state management via Ink and React.
    * `App.tsx`: Main structural React component rendering transcripts, approvals, input buffers, and headers.
* `tests/`: House equivalent unit and integration test files matched 1:1 with core features (e.g., `tests/workspace.test.ts` for `src/core/workspace.ts`).

## Constraints & Safety Boundaries

* **Path Resolution**: All filesystem operations within `WorkspaceTools` must strictly resolve paths against the workspace root to prevent path traversal vulnerabilities. Never escape the workspace root boundary.
* **Permission Enforcement**: Write actions (`write_file`, `apply_patch`) and executing scripts or shell tools require interactive confirmation or explicit programmatic user flags (`--apply`, `--allow-shell`).
* **Agent Protocol**: Tool input and output parsing relies on a custom JSON command envelope (containing `action`, `message`, and `tool_calls`). Do not depend on model-native tool calling syntax so compatibility remains high across weaker local endpoints.

## Exclusions & Files to Avoid

* Never modify or commit to `.patchpilot/` – this holds local JSONL session transaction files and is ignored by Git.
* Do not commit compiled output inside `dist/` or coverage files.
* Avoid modifying `code_tests/` structures arbitrarily unless verified via test suite configurations.
