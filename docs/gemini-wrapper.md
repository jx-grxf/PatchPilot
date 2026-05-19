# Gemini-Wrapper Setup

PatchPilot can use `gemini_webapi` through the `gemini-wrapper` provider. This is an advanced, unofficial Gemini Web bridge. PatchPilot creates a managed Python venv only when you explicitly run `/doctor fix` or `patchpilot doctor --fix`, installs the pinned wrapper there, and starts the bridge command itself. It does not scan browser profiles or read cookies automatically.

## 1. Let PatchPilot install the wrapper

Do not run `python3 -m pip install -U gemini_webapi` against Homebrew Python. Homebrew blocks that with PEP 668.

PatchPilot uses this managed venv instead:

```sh
~/.patchpilot/gemini-wrapper-venv
```

It creates the venv and installs the pinned `gemini_webapi` version when you explicitly approve `patchpilot doctor --fix` or `/doctor fix`. Normal chat startup does not install Python packages.

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
patchpilot --provider gemini-wrapper --model flash
patchpilot --provider gemini-wrapper --model thinking
patchpilot --provider gemini-wrapper --model pro
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
PATCHPILOT_MODEL=auto
PATCHPILOT_GEMINI_WRAPPER_MODE=python
PATCHPILOT_GEMINI_WRAPPER_COOKIES_JSON=/Users/you/.patchpilot/gemini-cookies.json
PATCHPILOT_GEMINI_WRAPPER_MIN_INTERVAL_MS=1500
PATCHPILOT_GEMINI_WRAPPER_TIMEOUT_MS=180000
```

If a pasted `__Secure-1PSIDTS` expires, PatchPilot retries the bridge request once without that optional timestamp. Transient WebAPI network timeouts are retried inside the bridge. Bridge calls are also serialized with a small default delay so advisor or agent requests do not hit the wrapper at the same instant. Set `PATCHPILOT_GEMINI_WRAPPER_MIN_INTERVAL_MS=0` only for debugging.

The default bridge timeout is 180 seconds. `gemini-3-pro` can take longer through the unofficial WebAPI bridge, so PatchPilot gives Pro models at least 240 seconds. For fast local test loops, use `auto`; PatchPilot omits the model parameter and lets Gemini Web pick its current default.

PatchPilot exposes four stable model shortcuts for the Python bridge:

| PatchPilot model | Gemini Web model |
| --- | --- |
| `auto` | omit model and let Gemini Web choose |
| `flash` | `gemini-3-flash` |
| `thinking` | `gemini-3-flash-thinking` |
| `pro` | `gemini-3-pro` |

`thinking` is a Gemini Web model mode exposed by `gemini_webapi`. It is not the same as the official Gemini API `thinkingBudget` or `thinkingLevel` controls.

The Python wrapper stores refreshed Google cookies in a PatchPilot-owned cache:

```text
~/.patchpilot/gemini-webapi-cache
```

PatchPilot creates that directory with owner-only permissions (`0700`) and passes it to `gemini_webapi` as `GEMINI_COOKIE_PATH`.

## 4. Verify

```sh
patchpilot doctor --provider gemini-wrapper --check-model auto
```

Expected checks:

- Node and Git are available.
- `gemini_webapi` imports through `~/.patchpilot/gemini-wrapper-venv/bin/python`.
- explicit cookie auth is configured.
- the bridge lists Gemini models.

## Security Boundary

PatchPilot never scans Chrome, Safari, Firefox, Arc, Edge, Brave, Keychain, or browser cookie stores. The only supported auth sources are the masked paste onboarding flow, an explicit cookie JSON path, or explicit `GEMINI_SECURE_1PSID` environment variables.
