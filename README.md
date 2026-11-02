<div align="center">

# PatchPilot

A terminal coding agent for local models. It runs on Ollama, LM Studio, MLX, llama.cpp or vLLM, on your machine or one you own, and asks before it edits a file or runs a command.

[![CI](https://github.com/jx-grxf/PatchPilot/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/jx-grxf/PatchPilot/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@jx-grxf/patchpilot)](https://www.npmjs.com/package/@jx-grxf/patchpilot)
![Node](https://img.shields.io/badge/node-%E2%89%A522.12-339933)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[Install](#install) · [Architecture](docs/architecture.md) · [Security](SECURITY.md) · [Releases](docs/releases)

</div>

> [!TIP]
> Built for working on a repository with a model that runs on your own hardware: no account, no API key, and nothing leaves the machines you pick.

## What it does

**Works with small local models**

- Native tool calling when the model supports it, checked once per model. Models without it fall back to a validated JSON protocol.
- Nine tools in total: `read`, `write`, `edit`, `glob`, `grep`, `bash`, `fetch_url`, `task` and `todo`. A small model picks the right tool more often from a short list.
- A repair step for malformed tool calls: calls left in the text, printed in a code fence, given an alias name or slightly broken JSON are recovered. Failures come back to the model as an error that names the valid options.
- Sampling follows each model family's published settings. Qwen, for example, gets its recommended presence penalty against repetition loops.

**Stays in your terminal**

- One conversation per session. Old tool output is pruned only above 70 % of the context window, and older turns are summarised above 85 %. `/compact` does it on demand.
- Answers stream as they are written. The status line shows prompt reading, tokens per second and context use.
- The transcript goes to the terminal's own scrollback, so scrolling, selecting and copying work as usual. Edits are shown as diffs.

**Background agents**

- The model can start `explore` (read-only) and `general` (can edit files) agents with the `task` tool. They run in the background while the main agent keeps working.
- The list under the status bar shows every agent with its time and tokens. Select one to read its history or send it a message. Esc stops the agent you are looking at, `ctrl+x ctrl+k` stops all of them.
- Agents have no shell and cannot start more agents. A write is refused when the file changed since that agent last read it.

**You decide what it may do**

- `plan` is read-only. `build` asks before every edit and command, once or for the whole session. `bypass` runs without asking, after a warning you accept.
- File tools stay inside the workspace. `.env`, SSH keys, certificates and other credential files are blocked.
- `fetch_url` reaches only the public internet: loopback, LAN, link-local and cloud-metadata addresses are refused, also after a DNS lookup.
- Models can run on another machine on your LAN or Tailscale. Files, Git, tests and the shell stay on the machine where you started PatchPilot.

## Install

PatchPilot needs Node.js 22.12 or newer, Git, and one local model runtime.

```bash
npm install -g @jx-grxf/patchpilot
cd /path/to/your/repository
patchpilot
```

The first launch opens setup. It finds every runtime that is running on this machine and lists its models. If nothing is running, it shows the install commands for your system. After you pick a model, it checks that the model can call tools.

No runtime installed yet? Ollama is the quickest start:

| System | Command |
|---|---|
| macOS | `brew install ollama` or the app from [ollama.com](https://ollama.com/download) |
| Linux | `curl -fsSL https://ollama.com/install.sh \| sh` |
| Windows | `winget install Ollama.Ollama` |

Then download the default model, Qwen3.5 9B (6.6 GB, runs well with 16 GB of RAM):

```bash
ollama pull qwen3.5:9b
```

On a Mac with Apple Silicon, `pip install mlx-lm` is enough. Setup then offers to start an MLX server with Qwen3.5 9B, and later launches start it again whenever nothing else serves the model. PatchPilot stops it on exit. Set `PATCHPILOT_AUTOSTART=0` to turn that off.

## Usage

```bash
patchpilot                                   # open the TUI in the current directory
patchpilot "find the riskiest untested path"  # start with a task
patchpilot models                            # list every running runtime and its models
patchpilot doctor                            # check Node, Git, the endpoint and the model
patchpilot bench                             # run fixed coding tasks against the model
patchpilot sessions                          # list sessions for this workspace
patchpilot resume [session-id]               # continue a session
patchpilot init                              # write a PATCHPILOT.md with project instructions
patchpilot cleanup [cache|sessions|temp|all]
```

Run options: `--workspace <path>`, `--provider ollama|local-openai`, `--model <name>`, `--ollama-url <url>`, `--subagents`, and `--apply --allow-shell` to start in bypass mode.

### Runtimes

| Runtime | `--provider` | Default endpoint |
|---|---|---|
| Ollama | `ollama` | `http://127.0.0.1:11434` |
| LM Studio | `lmstudio` | `http://127.0.0.1:1234/v1` |
| MLX (Apple Silicon) | `mlx` | `http://127.0.0.1:8080/v1` |
| llama.cpp | `llamacpp` | `http://127.0.0.1:8080/v1` |
| vLLM | `vllm` | `http://127.0.0.1:8000/v1` |

Everything except Ollama goes through one OpenAI-compatible client; set its URL with `PATCHPILOT_LOCAL_URL`. For Ollama on another machine, pass `--ollama-url http://192.168.1.50:11434` or use `/connect` in the TUI, which scans the LAN and Tailscale.

### In the TUI

Type `/` for the full command list. The ones you need most:

| Key or command | What it does |
|---|---|
| `Tab`, `/mode plan\|build\|bypass` | Switch permission mode |
| `/model`, `/models` | Change or list models |
| `/connect [host\|local]` | Use Ollama on another machine, or go back to this one |
| `/compact now` | Summarise older turns to free context |
| `/new`, `/sessions`, `/resume` | Start, list or continue sessions |
| `/diff` | Show the current Git diff |
| `/status`, `/usage` | Runtime, permissions, tokens and tool calls |
| `/doctor` | Check the setup |
| `/onboarding` | Run setup again |
| `Esc` | Stop the running answer |

## Configuration

Setup and `/set` save to `~/.patchpilot/.env`. [.env.example](.env.example) lists every variable. The ones you are most likely to change:

```dotenv
PATCHPILOT_PROVIDER=ollama
PATCHPILOT_MODEL=qwen3.5:9b
PATCHPILOT_OLLAMA_URL=http://127.0.0.1:11434
PATCHPILOT_LOCAL_URL=http://127.0.0.1:1234/v1
PATCHPILOT_NUM_CTX=32768
PATCHPILOT_DEFAULT_MODE=build
```

Ollama gets a 32k context by default, because it cuts long prompts silently from the front, system prompt first. `doctor` fails below 16k. Thinking is left to the model: PatchPilot turns it on or off only for model families that accept the switch.

Sessions are stored as JSONL in `.patchpilot/sessions/` inside the workspace. Add `.patchpilot/` to your `.gitignore`; `patchpilot init` does it for you.

## Development

```bash
npm ci
npm run dev -- "summarize this repository"
npm run typecheck
npm test
npm run build
```

Strict TypeScript with NodeNext ESM, React and Ink for the TUI, Zod at protocol boundaries, Vitest for tests. [docs/architecture.md](docs/architecture.md) explains the agent loop, the repair ladder and the compute model; [docs/product-context.md](docs/product-context.md) lists the rules every change has to keep.

Release notes are in [docs/releases](docs/releases). A `v*` tag runs CI, publishes to npm with provenance and creates the GitHub release.

## License

[MIT](LICENSE)
