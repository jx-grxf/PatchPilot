# Security Policy

## Supported Versions

PatchPilot is public preview software. Security fixes target the latest published npm version and the `main` branch.

## Reporting a Vulnerability

Please report security issues through GitHub Security Advisories:

https://github.com/jx-grxf/PatchPilot/security/advisories/new

Include:

- affected version or commit
- reproduction steps
- expected impact
- whether provider credentials, local files, or shell permissions are involved

Do not open a public issue for a vulnerability before the maintainer has had time to triage it.

## Security Model

PatchPilot keeps file tools inside one workspace root, blocks common secret files and credential-like extensions, and requires approval or explicit trusted bypass for writes and shell commands. Package-script approvals include the resolved script body because scripts can hide publish, push, or destructive commands.

Session logs are stored in `.patchpilot/sessions/` under the workspace and summarized in `~/.patchpilot/session-index.json`. Treat those logs as local project metadata: they may contain prompts, tool names, summaries, and clipped command output. Do not use cloud providers or trusted bypass in repositories containing secrets you do not want processed by external model providers.

Gemini-Wrapper support runs either the installed `gemini_webapi` Python package with an explicit cookie source or an explicit OpenAI-compatible URL from `PATCHPILOT_GEMINI_WRAPPER_BASE_URL`. PatchPilot must not scan browser profiles, cookies, Keychain items, or Google web-login sessions for provider auth.
