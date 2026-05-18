# PATCHPILOT.md

## Workspace Instructions
- Keep PatchPilot changes focused, testable, and easy to review.
- Prefer existing provider, TUI, and session patterns before adding abstractions.
- After behavior changes, run `npm run typecheck` and targeted `npm test`.
- Do not commit local sessions, caches, `.env` files, cookies, or generated tarballs.
