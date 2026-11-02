import type { AgentSessionEvent } from "./session.js";
import { SubagentTrace, subagentConcurrency, type SubagentEnvelope, type SubagentRequest, type SubagentType } from "./subagentRunner.js";
import type { AgentEvent, AgentEventToolName, ChatMessage } from "./types.js";

export type ChildAgentState = "queued" | "running" | "ok" | "failed" | "aborted" | "incomplete";

/** One row of a child's history. Stream events are never stored here. */
export type ChildEntry = { type: "user"; text: string } | { type: "event"; event: AgentEvent };

export type ChildAgentSnapshot = {
  id: string;
  agentType: SubagentType;
  description: string;
  state: ChildAgentState;
  startedAt: number;
  durationMs: number;
  promptTokens: number;
  outputTokens: number;
  toolCalls: number;
  activity?: { name: AgentEventToolName; arguments: Record<string, unknown> };
  streaming: { phase: "prompt" | "generating"; content: string; tokens: number; tokensPerSecond: number | null; writing: unknown } | null;
  entries: ChildEntry[];
  transcript: string | null;
};

export type ChildSpawnContext = {
  id: string;
  request: SubagentRequest;
  /** What this run is told: the prompt, or the message that woke it. */
  task: string;
  /** Kept by the supervisor across runs of this child. */
  conversation: ChatMessage[];
  /** The child's own, never linked to the main agent's. */
  signal: AbortSignal;
  drainInbox: () => string[];
};

export type ChildSpawner = (context: ChildSpawnContext) => AsyncGenerator<AgentEvent, void>;

export type SubagentDelivery = { id: string; envelope: SubagentEnvelope; toolCallId: string };

type Run = {
  childId: string;
  batchKey: string;
  wakes: boolean;
  done: boolean;
  envelope: SubagentEnvelope | null;
  delivered: boolean;
  toolCallId: string;
};

type Child = {
  id: string;
  request: SubagentRequest;
  state: ChildAgentState;
  startedAt: number;
  durationMs: number;
  runStartedAt: number | null;
  promptTokens: number;
  outputTokens: number;
  liveTokens: number;
  runResponseTokens: number;
  toolCalls: number;
  activity?: { name: AgentEventToolName; arguments: Record<string, unknown> };
  streaming: ChildAgentSnapshot["streaming"];
  entries: ChildEntry[];
  transcript: string | null;
  conversation: ChatMessage[];
  inbox: string[];
  controller: AbortController | null;
  run: Run | null;
  runCount: number;
  continuations: number;
  envelope: SubagentEnvelope | null;
};

/**
 * How often the main agent may restart one finished child per user prompt. A
 * test on a 9B model continued both children the moment they hit their cap and
 * was still at 86 tool calls after 25 minutes; each result woke it to do it again.
 */
const maxContinuationsPerPrompt = 1;

type SupervisorOptions = {
  transcriptDir: string;
  concurrency?: number;
  now?: () => number;
  persist?: (event: AgentSessionEvent) => void;
};

const activeStates: ReadonlySet<ChildAgentState> = new Set(["queued", "running"]);

export class AgentSupervisor {
  private readonly children = new Map<string, Child>();
  private readonly batches = new Map<string, Run[]>();
  private readonly queue: Array<{ child: Child; task: string }> = [];
  private readonly listeners = new Set<() => void>();
  private readonly concurrency: number;
  private readonly now: () => number;
  private spawner: ChildSpawner | null = null;
  private counter = 0;
  private running = 0;

  constructor(private readonly options: SupervisorOptions) {
    this.concurrency = Math.max(1, options.concurrency ?? subagentConcurrency());
    this.now = options.now ?? (() => Date.now());
  }

  setSpawner(spawner: ChildSpawner): void {
    this.spawner = spawner;
    this.pump();
  }

  start(request: SubagentRequest, batchId?: string): ChildAgentSnapshot {
    this.counter += 1;
    const id = `agent-${this.counter}`;
    const child = this.createChild(id, request, this.now());
    this.children.set(id, child);
    this.emit({ type: "agent.started", id, agentType: request.type, description: request.description, prompt: request.prompt, startedAt: child.startedAt });
    this.pushEntry(child, { type: "user", text: request.prompt });
    this.enqueue(child, request.prompt, batchId ?? `solo:${id}`, true);
    this.notify();
    return this.snapshot(child);
  }

  send(id: string, text: string, from: "user" | "main"): "queued" | "woken" | "unknown" | "limit" {
    const child = this.children.get(id);
    if (!child) {
      return "unknown";
    }
    const finished = !activeStates.has(child.state);
    if (finished && from === "main" && child.continuations >= maxContinuationsPerPrompt) {
      return "limit";
    }
    this.pushEntry(child, { type: "user", text });
    if (!finished) {
      child.inbox.push(text);
      if (from === "main" && child.run) {
        child.run.wakes = true;
      }
      this.notify();
      return "queued";
    }
    if (from === "main") {
      child.continuations += 1;
    }
    child.runCount += 1;
    this.enqueue(child, text, `rerun:${id}:${child.runCount}`, from === "main");
    this.notify();
    return "woken";
  }

  /** A new user prompt may ask for more work from any child. */
  resetContinuations(): void {
    for (const child of this.children.values()) {
      child.continuations = 0;
    }
  }

  stop(id: string): boolean {
    const child = this.children.get(id);
    if (!child) {
      return false;
    }
    if (child.state === "queued") {
      const index = this.queue.findIndex((item) => item.child === child);
      if (index >= 0) {
        this.queue.splice(index, 1);
      }
      this.complete(child, {
        status: "aborted",
        description: child.request.description,
        summary: "Stopped before it started.",
        steps: 0,
        durationMs: 0,
        toolCalls: 0,
        transcript: null
      });
      return true;
    }
    if (child.state === "running" && child.controller) {
      child.controller.abort();
      return true;
    }
    return false;
  }

  stopAll(): void {
    for (const child of [...this.children.values()]) {
      if (activeStates.has(child.state)) {
        this.stop(child.id);
      }
    }
  }

  list(): ChildAgentSnapshot[] {
    return [...this.children.values()].map((child) => this.snapshot(child));
  }

  get(id: string): ChildAgentSnapshot | undefined {
    const child = this.children.get(id);
    return child ? this.snapshot(child) : undefined;
  }

  /** The latest finished run's envelope, for a status question. */
  result(id: string): SubagentEnvelope | undefined {
    return this.children.get(id)?.envelope ?? undefined;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  takeFinished(): SubagentDelivery[] {
    const deliveries: SubagentDelivery[] = [];
    for (const runs of this.batches.values()) {
      if (!runs.every((run) => run.done)) {
        continue;
      }
      for (const run of runs) {
        if (!run.delivered && run.envelope) {
          run.delivered = true;
          deliveries.push({ id: run.childId, envelope: run.envelope, toolCallId: run.toolCallId });
        }
      }
    }
    return deliveries;
  }

  /**
   * A stopped child never wakes the main agent: whoever stopped it knows, and
   * waking on it would cost a model call to restate that.
   */
  hasWakeableResult(): boolean {
    for (const runs of this.batches.values()) {
      if (!runs.every((run) => run.done)) {
        continue;
      }
      if (runs.some((run) => !run.delivered && run.wakes && run.envelope && run.envelope.status !== "aborted")) {
        return true;
      }
    }
    return false;
  }

  hasActive(): boolean {
    return [...this.children.values()].some((child) => activeStates.has(child.state));
  }

  clear(): void {
    this.stopAll();
    this.queue.length = 0;
    this.children.clear();
    this.batches.clear();
    this.running = 0;
    this.notify();
  }

  restore(events: AgentSessionEvent[]): void {
    for (const event of events) {
      if (event.type === "agent.started") {
        const child = this.createChild(event.id, { type: event.agentType, description: event.description, prompt: event.prompt }, event.startedAt);
        child.state = "aborted";
        child.run = null;
        this.children.set(event.id, child);
        const number = /^agent-(\d+)$/.exec(event.id)?.[1];
        this.counter = Math.max(this.counter, number ? Number(number) : 0);
        continue;
      }
      const child = this.children.get(event.id);
      if (!child) {
        continue;
      }
      if (event.type === "agent.entry") {
        child.entries.push(event.entry);
        continue;
      }
      child.state = event.state === "queued" || event.state === "running" ? "aborted" : event.state;
      child.durationMs = event.durationMs;
      child.promptTokens = event.promptTokens;
      child.outputTokens = event.outputTokens;
      child.toolCalls = event.toolCalls;
      child.transcript = event.transcript;
      child.conversation = event.conversation;
      child.envelope = this.envelopeFromRestore(child);
    }
    this.notify();
  }

  private createChild(id: string, request: SubagentRequest, startedAt: number): Child {
    return {
      id,
      request,
      state: "queued",
      startedAt,
      durationMs: 0,
      runStartedAt: null,
      promptTokens: 0,
      outputTokens: 0,
      liveTokens: 0,
      runResponseTokens: 0,
      toolCalls: 0,
      streaming: null,
      entries: [],
      transcript: null,
      conversation: [],
      inbox: [],
      controller: null,
      run: null,
      runCount: 1,
      continuations: 0,
      envelope: null
    };
  }

  private envelopeFromRestore(child: Child): SubagentEnvelope {
    const last = [...child.entries].reverse().find((entry) => entry.type === "event" && (entry.event.type === "final" || entry.event.type === "error"));
    const message = last?.type === "event" && (last.event.type === "final" || last.event.type === "error") ? last.event.message : "";
    return {
      status: child.state === "ok" || child.state === "failed" || child.state === "incomplete" ? child.state : "aborted",
      description: child.request.description,
      summary: message.trim() || "The subagent produced no answer.",
      steps: 0,
      durationMs: child.durationMs,
      toolCalls: child.toolCalls,
      transcript: child.transcript
    };
  }

  private enqueue(child: Child, task: string, batchKey: string, wakes: boolean): void {
    const run: Run = { childId: child.id, batchKey, wakes, done: false, envelope: null, delivered: false, toolCallId: `deliver-${child.id}-${child.runCount}` };
    const runs = this.batches.get(batchKey);
    if (runs) {
      runs.push(run);
    } else {
      this.batches.set(batchKey, [run]);
    }
    child.run = run;
    child.state = "queued";
    this.queue.push({ child, task });
    this.pump();
  }

  private pump(): void {
    while (this.spawner && this.running < this.concurrency && this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) {
        this.launch(next.child, next.task, this.spawner);
      }
    }
  }

  private launch(child: Child, task: string, spawner: ChildSpawner): void {
    child.state = "running";
    child.runStartedAt = this.now();
    child.controller = new AbortController();
    child.runResponseTokens = 0;
    child.liveTokens = 0;
    this.running += 1;
    this.notify();
    void this.execute(child, task, spawner, child.controller);
  }

  private async execute(child: Child, task: string, spawner: ChildSpawner, controller: AbortController): Promise<void> {
    const signal = controller.signal;
    const trace = new SubagentTrace({ ...child.request, prompt: task }, this.now());
    // Raced against the iterator so a stop takes effect even when the child is
    // stuck inside something that ignores its signal.
    const aborted = new Promise<"aborted">((resolve) => {
      if (signal.aborted) {
        resolve("aborted");
      }
      signal.addEventListener("abort", () => resolve("aborted"), { once: true });
    });
    try {
      const iterator = spawner({ id: child.id, request: child.request, task, conversation: child.conversation, signal, drainInbox: () => child.inbox.splice(0) });
      for (;;) {
        const next = await Promise.race([iterator.next(), aborted]);
        if (next === "aborted") {
          void Promise.resolve(iterator.return(undefined)).catch(() => undefined);
          break;
        }
        if (next.done || this.children.get(child.id) !== child) {
          break;
        }
        trace.record(next.value);
        this.apply(child, next.value);
      }
    } catch (error) {
      trace.fail(error, signal.aborted);
    }
    if (signal.aborted) {
      trace.markAborted();
    }
    if (this.children.get(child.id) !== child) {
      return;
    }
    const envelope = await trace.finish(this.options.transcriptDir, this.now(), child.id);
    if (this.children.get(child.id) !== child) {
      return;
    }
    this.running = Math.max(0, this.running - 1);
    const wakes = child.run?.wakes ?? false;
    this.complete(child, envelope);
    // Text sent after the run's last look at its inbox would otherwise be shown
    // in the history and never read. A stop means the sender's message is moot.
    const unread = child.inbox.splice(0);
    if (unread.length > 0 && !signal.aborted) {
      child.runCount += 1;
      this.enqueue(child, unread.join("\n\n"), `rerun:${child.id}:${child.runCount}`, wakes);
    }
    this.pump();
  }

  private apply(child: Child, event: AgentEvent): void {
    switch (event.type) {
      case "stream":
        child.liveTokens = Math.max(0, event.tokens - child.runResponseTokens);
        child.streaming = {
          phase: event.phase,
          content: event.content,
          tokens: child.liveTokens,
          tokensPerSecond: event.tokensPerSecond,
          writing: event.writing ?? null
        };
        this.notify();
        return;
      case "metrics":
        child.promptTokens += event.metrics.promptTokens;
        child.outputTokens += event.metrics.responseTokens;
        child.runResponseTokens += event.metrics.responseTokens;
        child.liveTokens = 0;
        child.streaming = null;
        break;
      case "tool":
        child.toolCalls += 1;
        child.activity = { name: event.name, arguments: event.arguments ?? {} };
        child.streaming = null;
        break;
      case "assistant":
      case "final":
      case "error":
        child.streaming = null;
        break;
      default:
        break;
    }
    this.pushEntry(child, { type: "event", event });
    this.notify();
  }

  private complete(child: Child, envelope: SubagentEnvelope): void {
    if (child.runStartedAt !== null) {
      child.durationMs += this.now() - child.runStartedAt;
    }
    child.runStartedAt = null;
    child.controller = null;
    child.state = envelope.status;
    child.transcript = envelope.transcript ?? child.transcript;
    child.envelope = envelope;
    child.streaming = null;
    child.liveTokens = 0;
    child.activity = undefined;
    if (child.run) {
      child.run.done = true;
      child.run.envelope = envelope;
    }
    this.emit({
      type: "agent.finished",
      id: child.id,
      state: child.state,
      durationMs: child.durationMs,
      promptTokens: child.promptTokens,
      outputTokens: child.outputTokens,
      toolCalls: child.toolCalls,
      transcript: child.transcript,
      conversation: child.conversation
    });
    this.notify();
  }

  private snapshot(child: Child): ChildAgentSnapshot {
    return {
      id: child.id,
      agentType: child.request.type,
      description: child.request.description,
      state: child.state,
      startedAt: child.startedAt,
      durationMs: child.durationMs + (child.runStartedAt === null ? 0 : this.now() - child.runStartedAt),
      promptTokens: child.promptTokens,
      outputTokens: child.outputTokens + child.liveTokens,
      toolCalls: child.toolCalls,
      ...(child.activity ? { activity: child.activity } : {}),
      streaming: child.streaming ? { ...child.streaming } : null,
      entries: child.entries.slice(),
      transcript: child.transcript
    };
  }

  private pushEntry(child: Child, entry: ChildEntry): void {
    child.entries.push(entry);
    this.emit({ type: "agent.entry", id: child.id, entry });
  }

  private emit(event: AgentSessionEvent): void {
    try {
      const result: unknown = this.options.persist?.(event);
      if (result instanceof Promise) {
        result.catch(() => undefined);
      }
    } catch {
      // A failed write costs the restart history, never the running agents.
    }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // A broken subscriber must not stop the other agents or the loop.
      }
    }
  }
}
