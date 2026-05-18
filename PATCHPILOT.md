# PATCHPILOT.md

## Project Shape
- PatchPilot is a TypeScript/React Ink TUI for running visible, permissioned coding-agent loops inside one repository.
- Core agent/provider/tool code lives under `src/core/`; TUI orchestration and components live under `src/tui/`.
- Tests are Vitest files under `tests/`; prefer focused tests near the behavior being changed.

## Common Commands
- `npm run typecheck` checks TypeScript without emitting files.
- `npm test` runs the Vitest suite.
- `npm run build` cleans and compiles `dist/`.
- `npm audit --omit=dev --audit-level=moderate` must stay clean before release.
- `npm pack --dry-run` verifies the published package contents.

## Coding Rules
- Keep provider behavior explicit: no hidden browser-cookie scanning, no implicit cloud auth discovery, and no runtime package installs unless a doctor/onboarding fix explicitly requested it.
- Keep tool permissions separate. Write, shell, external file analysis, and memory persistence must not silently upgrade each other.
- Keep shell and file tools workspace-confined by default; external file reads require `/experimental file-analysis` plus approval.
- For TUI changes, preserve keyboard-first operation and avoid low-contrast dim text.

## Release Notes
- Version changes need `package.json`, `package-lock.json`, README release table, and `docs/releases/vX.Y.Z.md`.
- Do not ship if CI, typecheck, tests, production audit, npm signatures, or package dry-run fail.
