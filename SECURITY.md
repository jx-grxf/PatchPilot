# Security Policy

## Supported Versions

PatchPilot is public preview software. Security fixes target the latest published npm version and the `main` branch.

## Reporting a Vulnerability

Please report security issues through GitHub Security Advisories when available, or contact the maintainer privately with:

- affected version or commit
- reproduction steps
- expected impact
- whether provider credentials, local files, or shell permissions are involved

Do not open a public issue for a vulnerability before the maintainer has had time to triage it.

## Security Model

PatchPilot keeps file tools inside one workspace root, blocks common secret files and credential-like extensions, and requires approval or explicit trusted bypass for writes and shell commands. Package-script approvals include the resolved script body because scripts can hide publish, push, or destructive commands.

Session logs are stored in `.patchpilot/sessions/` under the workspace and summarized in `~/.patchpilot/session-index.json`. Treat those logs as local project metadata: they may contain prompts, tool names, summaries, and clipped command output. Do not use cloud providers or trusted bypass in repositories containing secrets you do not want processed by external model providers.
