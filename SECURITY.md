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

PatchPilot keeps file tools inside one workspace root, blocks common secret files, and requires explicit flags for writes and shell commands. Cloud providers may receive prompt and repository context under their own terms. Review diffs before committing generated changes.
