# Background agents

Subagents become background agents with their own visible history. The main agent keeps working while they run, and both the user and the main agent can message or stop any of them.

## Decisions

- **Display:** switching view clears the terminal and reprints the selected agent's history through `<Static>`, so wheel scrolling and selection stay native.
- **List and tree:** both stay. The tree stays above the composer, a list with time and tokens sits below the status bar.
- **Keys:** the composer always types to the selected agent, also during a run. Up and down move the selection when they would not move the caret or recall history. Esc stops the agent being viewed; on a finished agent it returns to main. `ctrl+x ctrl+k` stops all children.
- **Waking the main agent:** a child that finishes delivers its result to the main agent. An idle main agent wakes on its own. Children started in one reply deliver together, so one reply causes one wake.
- **A child woken by the user** does not wake the main agent; its result is delivered silently with the next main model call.
- **Messaging a finished child** runs it again on its own conversation.
- **File conflicts:** no locks across a whole run. Like Claude Code, a write is refused when the file changed since this agent last saw it, and the check and the write are one serialised step. Approval prompts run one at a time and name the agent. Worktree isolation is out of scope.
- **Retention:** all children stay listed for the whole session and survive a restart. `/clear` and `/new` stop and forget them.
- **Tool surface stays at nine.** `task` gains an `action` field.
- **MLX:** `--decode-concurrency 3`, the main agent plus two children.
- **Step cap:** a child that hits its cap makes one last call without tools and reports `incomplete`. A test run showed why: a bare "paused" message reached the parent as a success, and the parent invented a summary.
- **`glob` budget:** a walk stops at 20000 entries, starts at a pattern's literal directory, visits dot folders last, and says so when it was cut off. The same test run got `found 0` for `Brain/**/*.md` because `.claude/` used up the old budget of 1200.
- **No supervisor, no change.** An `AgentRunner` without a `supervisor` option keeps today's blocking `task` behaviour, so `bench` and one-shot runs are unaffected.

## Core contract

### `src/core/agentSupervisor.ts`

```ts
export type ChildAgentState = "queued" | "running" | "ok" | "failed" | "aborted";

/** One row of a child's history. Stream events are never stored here. */
export type ChildEntry = { type: "user"; text: string } | { type: "event"; event: AgentEvent };

export type ChildAgentSnapshot = {
  id: string;                  // "agent-1", "agent-2", numbered per session, never reused
  agentType: SubagentType;
  description: string;
  state: ChildAgentState;
  startedAt: number;
  durationMs: number;          // live while running, sums every run of this child
  promptTokens: number;        // from metrics events, summed
  outputTokens: number;        // from metrics events, summed, plus the live count of the current call
  toolCalls: number;
  activity?: { name: AgentEventToolName; arguments: Record<string, unknown> };
  streaming: { phase: "prompt" | "generating"; content: string; tokens: number; tokensPerSecond: number | null; writing: unknown } | null;
  entries: ChildEntry[];
  transcript: string | null;
};

export type ChildSpawnContext = {
  id: string;
  request: SubagentRequest;
  task: string;                // what this run is told; the prompt, or the message that woke it
  conversation: ChatMessage[]; // kept by the supervisor across runs of this child
  signal: AbortSignal;         // the child's own, never linked to the main agent's
  drainInbox: () => string[];
};

export type ChildSpawner = (context: ChildSpawnContext) => AsyncGenerator<AgentEvent, void>;

export type AgentRecord = AgentSessionEvent; // see Persistence

export class AgentSupervisor {
  constructor(options: { transcriptDir: string; concurrency?: number; now?: () => number; persist?: (event: AgentSessionEvent) => void });
  setSpawner(spawner: ChildSpawner): void;     // the latest wins; used by starts and wakes
  start(request: SubagentRequest, batchId?: string): ChildAgentSnapshot;
  send(id: string, text: string, from: "user" | "main"): "queued" | "woken" | "unknown";
  stop(id: string): boolean;
  stopAll(): void;
  list(): ChildAgentSnapshot[];
  get(id: string): ChildAgentSnapshot | undefined;
  subscribe(listener: () => void): () => void;  // called on any change, including stream progress
  takeFinished(): SubagentDelivery[];           // complete batches only; each delivered once
  hasWakeableResult(): boolean;                 // a complete batch that may wake an idle main agent
  hasActive(): boolean;                         // queued or running
  clear(): void;                                // stopAll and forget everything
  restore(events: AgentSessionEvent[]): void;   // unfinished children come back as "aborted"
}

export type SubagentDelivery = { id: string; envelope: SubagentEnvelope; toolCallId: string };
```

Rules:

- Never throws out of a child; a failed child is a state. Reuse `runSubagent`'s event handling and `formatEnvelope`/`clampSummary` where they fit, moving the shared part rather than copying it.
- `concurrency` defaults to `subagentConcurrency()` (2) for both agent types. Others wait as `queued` and start in order.
- A batch is complete once none of its children is queued or running. A child started without a batch id is its own batch.
- `send` to a running child queues the text for `drainInbox`. To a finished one it starts a new run with the text as `task`. Both add a `{ type: "user" }` entry. Only `from: "main"` makes the eventual result wake the main agent; `from: "user"` delivers it silently.
- `stop` aborts that child's signal; queued children are dropped to `aborted` without running.

### `src/core/agent.ts`

New `AgentRunnerOptions`:

```ts
supervisor?: AgentSupervisor;
inbox?: () => string[];                // drained before each model call
writeCoordinator?: WriteCoordinator;
agentKey?: string;                     // defaults to "main"
```

- Export `createChildSpawner(options: AgentRunnerOptions): ChildSpawner`, built from today's `runChildAgent` options, with `conversation`, `signal` and `inbox` from the context, and `agentKey: context.id`. The TUI also calls it when a restored child is messaged before the main agent has run.
- With a supervisor, `run` calls `supervisor.setSpawner(createChildSpawner(this.options))` and `task` dispatches by `action`:
  - `start` calls `supervisor.start` with one batch id per reply and answers at once: `Started agent-2 (explore): <description>. It runs in the background and its result reaches you automatically. Keep working, or end your turn if nothing else is left.`
  - `message` needs `id` and `prompt`; it calls `supervisor.send(id, prompt, "main")`.
  - `stop` needs `id`; it calls `supervisor.stop`.
  - `status` with `id` answers with that child's envelope or progress; without `id` it lists every child, one line each. This is how the main agent resolves "stop the second one".
- A wrong action or unknown id answers in its result slot and lists the valid choices (L4). No `yield` of `subagent` events on this path; the UI reads the supervisor.
- Without a supervisor, `start` behaves as today and the other actions answer that no background agents exist.
- Before each model call, including the first:
  1. For every `supervisor.takeFinished()` delivery, append an assistant message with one call `task {"action":"status","id":"agent-N"}` and a `role: "tool"` result holding `formatEnvelope`, and yield the existing `tool` event with `name: "subagent"` and its metadata, so the transcript prints it. Never put a result into a user message.
  2. For every `inbox()` string, append a user message.
- A reply without tool calls ends the turn only if nothing is waiting: check `inbox` and `takeFinished` first and continue the loop if either has something. Do not wait for children still running.
- `run(task, { wake: true })` starts the loop without appending a user message, for an idle main agent woken by a result. The history then ends on the synthetic tool result, which is a valid request.
- The system prompt gains one short static paragraph on background agents only when a supervisor is set: results arrive by themselves, never poll in a loop. It must not vary per turn, because the prefix is the cache.

### `src/core/toolSchema.ts`

`task` gets `action` (`start`, `message`, `stop`, `status`) and `id`; `action` is the only required field, and `prompt` also carries the message text. The description still ends in one worked example. In `toolRepair.ts`, L3 treats a missing `action` as `start` when `prompt` is present, so old habits and the blocking path keep working. L4 names what is missing for `start`.

### `src/core/writeCoordinator.ts`

```ts
export class WriteCoordinator {
  /** Records what an agent has seen. Partial reads count, using the whole file's hash. */
  recordSeen(agentKey: string, absolutePath: string, contentHash: string): void;
  /**
   * Runs check-and-write as one serialised step per process. Returns the refusal text
   * instead of calling `write` when the file is stale for this agent.
   */
  withWrite<T>(agentKey: string, absolutePath: string, write: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; refusal: string }>;
}
export function serializeApprovals(handler: ApprovalHandler): ApprovalHandler;
```

Stale means:

- the agent saw the file and its current hash differs from what it saw, or
- the agent never saw the file and another agent of this session wrote it.

An agent that never saw an untouched file writes as today, so models are not pushed into new refusal loops. A successful write counts as seen for the writer and records it as the file's last writer. A refusal follows L4: `src/a.ts changed since you last read it (agent-2 wrote it). Read it again, then retry.`

Wire it into `WorkspaceTools` through the options `coordinator` and `agentKey`. Cover `writeFile`, `editFile` and `applyPatch` for each touched path, and record on `readFile`, `readRange` and `readTextDocument`. Without a coordinator nothing changes. The approval prompt happens outside `withWrite`, so a waiting prompt never blocks another agent.

`serializeApprovals` chains calls so one prompt is open at a time; a request whose `signal` has aborted by its turn is denied without prompting. `ApprovalRequest` gets an optional `agent` label, which the child's handler sets to `agent-N`. Add the optional `signal` too if it is missing.

### Persistence, `src/core/session.ts`

```ts
export type AgentSessionEvent =
  | { type: "agent.started"; id: string; agentType: SubagentType; description: string; prompt: string; startedAt: number }
  | { type: "agent.entry"; id: string; entry: ChildEntry }
  | { type: "agent.finished"; id: string; state: ChildAgentState; durationMs: number; promptTokens: number; outputTokens: number; toolCalls: number; transcript: string | null; conversation: ChatMessage[] };
```

- Part of `SessionEvent`, ignored by `formatEventForResume`.
- Export `readAgentEvents(sessionPath: string): Promise<AgentSessionEvent[]>`.
- Several agents now append concurrently: serialise `append`, including the index update, through one promise chain, so no line interleaves and the index is never overwritten by a stale read.
- `ChildEntry`, `ChildAgentState` and `SubagentType` are imported as types; no runtime import from the supervisor into `session.ts`.

### `src/core/autostart.ts`

`--decode-concurrency 3` and the comment above it. Leave the cache flags alone.

## TUI

Built separately against the contract above; the core must not import from `src/tui/`.
