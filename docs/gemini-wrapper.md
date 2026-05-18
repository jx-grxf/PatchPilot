# Gemini-Wrapper Setup

PatchPilot can use `gemini_webapi` through the `gemini-wrapper` provider. PatchPilot creates a managed Python venv, installs the wrapper there, and starts the bridge command itself. It does not scan browser profiles or read cookies automatically.

## 1. Let PatchPilot install the wrapper

Do not run `python3 -m pip install -U gemini_webapi` against Homebrew Python. Homebrew blocks that with PEP 668.

PatchPilot uses this managed venv instead:

```sh
~/.patchpilot/gemini-wrapper-venv
```

It creates the venv and installs `gemini_webapi` automatically when `patchpilot doctor --provider gemini-wrapper` or Gemini-Wrapper onboarding needs it.

## 2. Get the cookie values manually

1. Open `https://gemini.google.com`.
2. Open DevTools.
3. Go to Application or Storage.
4. Open Cookies for `https://gemini.google.com`.
5. Copy `__Secure-1PSID`.
6. Copy `__Secure-1PSIDTS` if it exists.

Do not paste these values into issues, logs, chats, or commits. `__Secure-1PSID` acts like a Google session token.

## 3. Run PatchPilot onboarding

```sh
patchpilot --provider gemini-wrapper
```

Choose `Gemini-Wrapper` in setup. PatchPilot asks for:

```text
psid > ********
ts   > ********
```

`psid` is required. `ts` is optional; press Enter to skip it.

PatchPilot writes:

```text
~/.patchpilot/gemini-cookies.json
```

with owner-only file permissions (`0600`) and stores this config:

```sh
PATCHPILOT_PROVIDER=gemini-wrapper
PATCHPILOT_MODEL=gemini-2.5-flash
PATCHPILOT_GEMINI_WRAPPER_MODE=python
PATCHPILOT_GEMINI_WRAPPER_COOKIES_JSON=/Users/you/.patchpilot/gemini-cookies.json
```

## 4. Verify

```sh
patchpilot doctor --provider gemini-wrapper --check-model gemini-2.5-flash
```

Expected checks:

- Node and Git are available.
- `gemini_webapi` imports through `~/.patchpilot/gemini-wrapper-venv/bin/python`.
- explicit cookie auth is configured.
- the bridge lists Gemini models.

## Security Boundary

PatchPilot never scans Chrome, Safari, Firefox, Arc, Edge, Brave, Keychain, or browser cookie stores. The only supported auth sources are the masked paste onboarding flow, an explicit cookie JSON path, or explicit `GEMINI_SECURE_1PSID` environment variables.
