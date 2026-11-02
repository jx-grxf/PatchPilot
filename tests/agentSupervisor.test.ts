import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentSupervisor, type ChildSpawner, type ChildSpawnContext } from "../src/core/agentSupervisor.js";
import { AgentRunner, createChildSpawner } from "../src/core/agent.js";
import { setModelCapabilities } from "../src/core/capability.js";
import type { AgentEvent, ChatMessage, ModelChatOptions, ModelChatResult, ModelClient, ProviderTool, RawToolCall } from "../src/core/types.js";

const metricsEvent: AgentEvent = {
  type: "metrics",
  workState: "planning",
  metrics: {
    promptTokens: 10,
    cachedPromptTokens: 0,
    cacheWriteTokens: 0,
    responseTokens: 5,
    totalTokens: 15,
    evalTokensPerSecond: null,
    timeToFirstTokenMs: null,
    promptDurationMs: 0,
    responseDurationMs: 0,
    totalDurationMs: 0,
    estimatedCostUsd: 0,
    tokenSource: "provider",
    costSource: "local"
  }
};

function telemetry(): ModelChatResult["telemetry"] {
  return metricsEvent.type === "metrics" ? metricsEvent.metrics : (undefined as never);
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was never met");
}

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

function onAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** Children that wait for `release(task)`, then answer `done: <task>`. */
function gatedSpawner() {
  const gates = new Map<string, ReturnType<typeof gate>>();
  const gateFor = (task: string) => {
    let existing = gates.get(task);
    if (!existing) {
      existing = gate();
      gates.set(task, existing);
    }
    return existing;
  };
  const contexts: ChildSpawnContext[] = [];
  const spawner: ChildSpawner = async function* (context) {
    contexts.push(context);
    await Promise.race([gateFor(context.task).promise, onAbort(context.signal)]);
    if (context.signal.aborted) {
      yield { type: "final", message: "Stopped.", workState: "done" };
      return;
    }
    yield metricsEvent;
    yield { type: "final", message: `done: ${context.task}`, workState: "done" };
  };
  return { spawner, contexts, release: (task: string) => gateFor(task).open() };
}

async function newSupervisor(concurrency = 2) {
  const supervisor = new AgentSupervisor({ transcriptDir: await mkdtemp(path.join(tmpdir(), "pp-sup-")), concurrency });
  return supervisor;
}

const explore = (prompt: string) => ({ type: "explore" as const, description: `d ${prompt}`, prompt });

describe("concurrency", () => {
  it("runs two at once and starts the rest in order as slots free", async () => {
    const supervisor = await newSupervisor(2);
    const { spawner, contexts, release } = gatedSpawner();
    supervisor.setSpawner(spawner);

    supervisor.start(explore("a"));
    supervisor.start(explore("b"));
    supervisor.start(explore("c"));
    supervisor.start(explore("d"));

    await until(() => contexts.length === 2);
    expect(supervisor.list().map((child) => child.state)).toEqual(["running", "running", "queued", "queued"]);

    release("b");
    await until(() => contexts.length === 3);
    expect(contexts.map((context) => context.task)).toEqual(["a", "b", "c"]);
    expect(supervisor.get("agent-4")?.state).toBe("queued");

    release("a");
    await until(() => contexts.length === 4);
    expect(contexts[3]?.id).toBe("agent-4");
    release("c");
    release("d");
    await until(() => !supervisor.hasActive());
  });

  it("holds queued children until a spawner exists", async () => {
    const supervisor = await newSupervisor();
    supervisor.start(explore("a"));
    expect(supervisor.get("agent-1")?.state).toBe("queued");

    const { spawner, release } = gatedSpawner();
    supervisor.setSpawner(spawner);
    expect(supervisor.get("agent-1")?.state).toBe("running");
    release("a");
    await until(() => !supervisor.hasActive());
  });
});

describe("delivery", () => {
  it("hands a batch over only when every child in it is done, and only once", async () => {
    const supervisor = await newSupervisor(4);
    const { spawner, release } = gatedSpawner();
    supervisor.setSpawner(spawner);
    supervisor.start(explore("a"), "reply-1");
    supervisor.start(explore("b"), "reply-1");
    supervisor.start(explore("solo"));

    release("a");
    release("solo");
    await until(() => supervisor.get("agent-1")?.state === "ok" && supervisor.get("agent-3")?.state === "ok");

    const first = supervisor.takeFinished();
    expect(first.map((delivery) => delivery.id)).toEqual(["agent-3"]);
    expect(supervisor.hasWakeableResult()).toBe(false);

    release("b");
    await until(() => supervisor.get("agent-2")?.state === "ok");
    expect(supervisor.hasWakeableResult()).toBe(true);
    const second = supervisor.takeFinished();
    expect(second.map((delivery) => delivery.id)).toEqual(["agent-1", "agent-2"]);
    expect(second[0]?.envelope.summary).toBe("done: a");
    expect(supervisor.takeFinished()).toEqual([]);
    expect(supervisor.hasWakeableResult()).toBe(false);
  });

  it("wakes for children the main agent started or messaged, not for ones the user woke", async () => {
    const supervisor = await newSupervisor();
    const { spawner, contexts, release } = gatedSpawner();
    supervisor.setSpawner(spawner);
    supervisor.start(explore("a"));
    release("a");
    await until(() => supervisor.get("agent-1")?.state === "ok");
    expect(supervisor.hasWakeableResult()).toBe(true);
    supervisor.takeFinished();

    expect(supervisor.send("agent-1", "u1", "user")).toBe("woken");
    release("u1");
    await until(() => supervisor.get("agent-1")?.state === "ok");
    expect(supervisor.hasWakeableResult()).toBe(false);
    expect(supervisor.takeFinished().map((delivery) => delivery.envelope.summary)).toEqual(["done: u1"]);

    expect(supervisor.send("agent-1", "m1", "main")).toBe("woken");
    release("m1");
    await until(() => supervisor.get("agent-1")?.state === "ok");
    expect(supervisor.hasWakeableResult()).toBe(true);
    supervisor.takeFinished();

    supervisor.send("agent-1", "u2", "user");
    supervisor.send("agent-1", "from main while running", "main");
    release("u2");
    release("from main while running");
    await until(() => contexts.filter((context) => context.task === "from main while running").length === 1 && supervisor.get("agent-1")?.state === "ok");
    expect(supervisor.hasWakeableResult()).toBe(true);
  });

  it("lets the main agent continue a finished child once per prompt, and the user always", async () => {
    const supervisor = await newSupervisor();
    const { spawner, contexts, release } = gatedSpawner();
    supervisor.setSpawner(spawner);
    supervisor.start(explore("a"));
    release("a");
    await until(() => supervisor.get("agent-1")?.state === "ok");

    expect(supervisor.send("agent-1", "m1", "main")).toBe("woken");
    release("m1");
    await until(() => contexts.length === 2 && supervisor.get("agent-1")?.state === "ok");

    const entries = supervisor.get("agent-1")?.entries.length;
    expect(supervisor.send("agent-1", "m2", "main")).toBe("limit");
    expect(supervisor.get("agent-1")?.entries.length).toBe(entries);

    expect(supervisor.send("agent-1", "u1", "user")).toBe("woken");
    release("u1");
    await until(() => contexts.length === 3 && supervisor.get("agent-1")?.state === "ok");

    supervisor.resetContinuations();
    expect(supervisor.send("agent-1", "m3", "main")).toBe("woken");
    release("m3");
    await until(() => contexts.length === 4 && supervisor.get("agent-1")?.state === "ok");
  });

  it("runs a child again for text its last run never read", async () => {
    const supervisor = await newSupervisor();
    const { spawner, contexts, release } = gatedSpawner();
    supervisor.setSpawner(spawner);
    supervisor.start(explore("a"));
    await until(() => contexts.length === 1);
    expect(supervisor.send("agent-1", "one more thing", "user")).toBe("queued");

    release("a");
    await until(() => contexts.length === 2);
    expect(contexts[1]?.task).toBe("one more thing");
    expect(contexts[1]?.conversation).toBe(contexts[0]?.conversation);

    release("one more thing");
    await until(() => supervisor.get("agent-1")?.state === "ok");
  });

  it("drops unread text when the child was stopped", async () => {
    const supervisor = await newSupervisor();
    const { spawner, contexts } = gatedSpawner();
    supervisor.setSpawner(spawner);
    supervisor.start(explore("a"));
    await until(() => contexts.length === 1);
    supervisor.send("agent-1", "never mind", "user");
    supervisor.stop("agent-1");
    await until(() => supervisor.get("agent-1")?.state === "aborted");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(contexts).toHaveLength(1);
  });

  it("delivers a stopped child without waking anyone", async () => {
    const supervisor = await newSupervisor();
    const { spawner, contexts } = gatedSpawner();
    supervisor.setSpawner(spawner);
    supervisor.start(explore("a"));
    await until(() => contexts.length === 1);
    supervisor.stop("agent-1");
    await until(() => supervisor.get("agent-1")?.state === "aborted");
    expect(supervisor.hasWakeableResult()).toBe(false);
    expect(supervisor.takeFinished()[0]?.envelope.status).toBe("aborted");
  });
});

describe("messages", () => {
  it("queues text for a running child and re-runs a finished one", async () => {
    const supervisor = await newSupervisor();
    const { spawner, contexts, release } = gatedSpawner();
    supervisor.setSpawner(spawner);
    supervisor.start(explore("a"));
    await until(() => contexts.length === 1);

    expect(supervisor.send("agent-1", "also check b", "user")).toBe("queued");
    expect(contexts[0]?.drainInbox()).toEqual(["also check b"]);
    expect(contexts[0]?.drainInbox()).toEqual([]);

    release("a");
    await until(() => supervisor.get("agent-1")?.state === "ok");
    expect(supervisor.send("agent-1", "again", "user")).toBe("woken");
    await until(() => contexts.length === 2);
    expect(contexts[1]?.task).toBe("again");
    release("again");
    await until(() => supervisor.get("agent-1")?.state === "ok");

    const users = supervisor.get("agent-1")?.entries.filter((entry) => entry.type === "user");
    expect(users).toEqual([
      { type: "user", text: "a" },
      { type: "user", text: "also check b" },
      { type: "user", text: "again" }
    ]);
  });

  it("answers unknown for an id it never issued", async () => {
    const supervisor = await newSupervisor();
    expect(supervisor.send("agent-9", "hi", "main")).toBe("unknown");
    expect(supervisor.stop("agent-9")).toBe(false);
  });

  it("keeps a finished child's conversation for its next run", async () => {
    const supervisor = await newSupervisor();
    const seen: number[] = [];
    supervisor.setSpawner(async function* (context) {
      seen.push(context.conversation.length);
      context.conversation.push({ role: "user", content: context.task });
      yield { type: "final", message: "ok", workState: "done" };
    });
    supervisor.start(explore("first"));
    await until(() => supervisor.get("agent-1")?.state === "ok");
    supervisor.send("agent-1", "second", "user");
    await until(() => seen.length === 2 && supervisor.get("agent-1")?.state === "ok");
    expect(seen).toEqual([0, 1]);
  });
});

describe("stopping", () => {
  it("stops one child and leaves the others running", async () => {
    const supervisor = await newSupervisor();
    const { spawner, contexts, release } = gatedSpawner();
    supervisor.setSpawner(spawner);
    supervisor.start(explore("a"));
    supervisor.start(explore("b"));
    await until(() => contexts.length === 2);

    expect(supervisor.stop("agent-1")).toBe(true);
    await until(() => supervisor.get("agent-1")?.state === "aborted");
    expect(supervisor.get("agent-2")?.state).toBe("running");
    expect(contexts[0]?.signal.aborted).toBe(true);
    expect(contexts[1]?.signal.aborted).toBe(false);
    expect(supervisor.stop("agent-1")).toBe(false);

    release("b");
    await until(() => supervisor.get("agent-2")?.state === "ok");
  });

  it("drops a queued child to aborted without running it", async () => {
    const supervisor = await newSupervisor(1);
    const { spawner, contexts, release } = gatedSpawner();
    supervisor.setSpawner(spawner);
    supervisor.start(explore("a"));
    supervisor.start(explore("b"));
    await until(() => contexts.length === 1);

    expect(supervisor.stop("agent-2")).toBe(true);
    expect(supervisor.get("agent-2")?.state).toBe("aborted");
    release("a");
    await until(() => supervisor.get("agent-1")?.state === "ok");
    expect(contexts).toHaveLength(1);
  });

  it("stops everything and forgets it on clear", async () => {
    const supervisor = await newSupervisor();
    const { spawner, contexts } = gatedSpawner();
    supervisor.setSpawner(spawner);
    supervisor.start(explore("a"));
    await until(() => contexts.length === 1);
    supervisor.clear();
    expect(supervisor.list()).toEqual([]);
    expect(contexts[0]?.signal.aborted).toBe(true);
    expect(supervisor.start(explore("b")).id).toBe("agent-2");
  });
});

describe("snapshots", () => {
  it("shows stream progress live without storing it in the history", async () => {
    const supervisor = await newSupervisor();
    const hold = gate();
    supervisor.setSpawner(async function* () {
      yield { type: "stream", phase: "generating", elapsedMs: 5, tokens: 12, content: "partial", tokensPerSecond: 40, workState: "planning" };
      await hold.promise;
      yield metricsEvent;
      yield { type: "stream", phase: "generating", elapsedMs: 9, tokens: 5 + 7, content: "more", tokensPerSecond: 40, workState: "planning" };
      await hold.promise;
      yield { type: "final", message: "ok", workState: "done" };
    });
    let notifications = 0;
    supervisor.subscribe(() => {
      notifications += 1;
    });
    supervisor.start(explore("a"));

    await until(() => supervisor.get("agent-1")?.streaming?.content === "partial");
    const live = supervisor.get("agent-1");
    expect(live?.streaming).toMatchObject({ tokens: 12, tokensPerSecond: 40 });
    expect(live?.outputTokens).toBe(12);
    expect(live?.entries.every((entry) => entry.type !== "event" || entry.event.type !== "stream")).toBe(true);
    expect(notifications).toBeGreaterThan(0);

    hold.open();
    await until(() => supervisor.get("agent-1")?.state === "ok");
    const done = supervisor.get("agent-1");
    expect(done?.outputTokens).toBe(5);
    expect(done?.promptTokens).toBe(10);
    expect(done?.streaming).toBeNull();
    expect(done?.entries.some((entry) => entry.type === "event" && entry.event.type === "stream")).toBe(false);
  });

  it("turns a throwing child into a failed state", async () => {
    const supervisor = await newSupervisor();
    // eslint-disable-next-line require-yield
    supervisor.setSpawner(async function* () {
      throw new Error("child exploded");
    });
    supervisor.start(explore("a"));
    await until(() => supervisor.get("agent-1")?.state === "failed");
    expect(supervisor.takeFinished()[0]?.envelope.summary).toBe("child exploded");
  });

  it("marks a child that hit its step cap incomplete rather than ok", async () => {
    const supervisor = await newSupervisor();
    supervisor.setSpawner(async function* () {
      yield { type: "final", message: "Found A; B is missing.", workState: "done", stoppedBy: "step_limit" };
    });
    supervisor.start(explore("a"));
    await until(() => supervisor.get("agent-1")?.state === "incomplete");
    expect(supervisor.takeFinished()[0]?.envelope).toMatchObject({ status: "incomplete", summary: "Found A; B is missing." });
  });

  it("brings unfinished children back as aborted", async () => {
    const supervisor = await newSupervisor();
    supervisor.restore([
      { type: "agent.started", id: "agent-1", agentType: "explore", description: "d", prompt: "p", startedAt: 1 },
      { type: "agent.entry", id: "agent-1", entry: { type: "user", text: "p" } },
      { type: "agent.started", id: "agent-2", agentType: "general", description: "e", prompt: "q", startedAt: 2 },
      {
        type: "agent.finished",
        id: "agent-2",
        state: "ok",
        durationMs: 5,
        promptTokens: 1,
        outputTokens: 2,
        toolCalls: 3,
        transcript: null,
        conversation: [{ role: "user", content: "q" }]
      }
    ]);
    expect(supervisor.list().map((child) => [child.id, child.state])).toEqual([
      ["agent-1", "aborted"],
      ["agent-2", "ok"]
    ]);
    expect(supervisor.start(explore("x")).id).toBe("agent-3");
    expect(supervisor.hasWakeableResult()).toBe(false);
  });
});

type Reply = { content?: string; toolCalls?: RawToolCall[] };
type Seen = { messages: ChatMessage[]; tools?: ProviderTool[] };

/** Routes by the first user message: "CHILD..." belongs to a child agent. */
function routedClient(main: Reply[], child: Reply[], hooks: { beforeMain?: (call: number) => Promise<void> } = {}) {
  const seen = { main: [] as Seen[], child: [] as Seen[] };
  const client: ModelClient = {
    async chat(options: ModelChatOptions): Promise<ModelChatResult> {
      const first = options.messages.find((message) => message.role === "user")?.content ?? "";
      const isChild = first.startsWith("CHILD");
      (isChild ? seen.child : seen.main).push({ messages: structuredClone(options.messages), tools: options.tools });
      if (!isChild) {
        await hooks.beforeMain?.(seen.main.length - 1);
      }
      const reply = (isChild ? child : main).shift() ?? { content: "done" };
      return { content: reply.content ?? "", toolCalls: reply.toolCalls, telemetry: telemetry() };
    },
    async listModels() {
      return [];
    }
  };
  return { client, seen };
}

async function mainRunner(options: {
  client: ModelClient;
  supervisor?: AgentSupervisor;
  inbox?: () => string[];
  signal?: AbortSignal;
  conversation?: ChatMessage[];
  closingCallOnCap?: boolean;
  maxSteps?: number;
}) {
  setModelCapabilities("local-openai", "scripted", { nativeToolCalls: true, detail: "test" });
  const workspace = await mkdtemp(path.join(tmpdir(), "pp-sup-ws-"));
  return new AgentRunner({
    provider: "local-openai",
    model: "scripted",
    ollamaUrl: "http://127.0.0.1:1234/v1",
    workspace,
    mode: "build",
    allowWrite: true,
    allowShell: false,
    maxSteps: options.maxSteps ?? 50,
    subagents: true,
    client: options.client,
    conversation: options.conversation ?? [],
    supervisor: options.supervisor,
    inbox: options.inbox,
    signal: options.signal,
    closingCallOnCap: options.closingCallOnCap
  });
}

async function drain(events: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const seen: AgentEvent[] = [];
  for await (const event of events) {
    seen.push(event);
  }
  return seen;
}

const toolResults = (messages: ChatMessage[]) => messages.filter((message) => message.role === "tool");

describe("the main loop with a supervisor", () => {
  it("ends the turn on the second status poll in a row while a child runs", async () => {
    const supervisor = await newSupervisor();
    supervisor.setSpawner(gatedSpawner().spawner);
    supervisor.start(explore("a"));
    const poll = { toolCalls: [{ id: "p", name: "task", arguments: { action: "status", id: "agent-1" } }] };
    const { client, seen } = routedClient([poll, poll, poll, { content: "never reached" }], []);
    const runner = await mainRunner({ client, supervisor });
    const events = await drain(runner.run("how far are they"));
    expect(seen.main).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: "final", message: "Waiting for the background agents.", workState: "done" });
  });

  it("offers task once children exist, whatever the turn's wording", async () => {
    const supervisor = await newSupervisor();
    supervisor.setSpawner(gatedSpawner().spawner);
    supervisor.start(explore("a"));
    const { client, seen } = routedClient([{ content: "Stopped it." }], []);
    const runner = await mainRunner({ client, supervisor, subagents: false });
    await drain(runner.run("stop the second one"));
    expect(seen.main[0]?.tools?.map((tool) => tool.function.name)).toContain("task");
  });

  it("injects a finished child as a task call and its result, and inbox text as a user message", async () => {
    const supervisor = await newSupervisor();
    const { spawner, release } = gatedSpawner();
    supervisor.setSpawner(spawner);
    supervisor.start(explore("a"));
    release("a");
    await until(() => supervisor.get("agent-1")?.state === "ok");

    let inboxCalls = 0;
    const { client, seen } = routedClient([{ content: "Got it." }], []);
    const runner = await mainRunner({ client, supervisor, inbox: () => (inboxCalls++ === 0 ? ["please be brief"] : []) });
    const events = await drain(runner.run("summarise"));

    const request = seen.main[0]?.messages ?? [];
    expect(request.map((message) => message.role)).toEqual(["system", "assistant", "tool", "user", "user"]);
    expect(request[1]?.toolCalls?.[0]).toMatchObject({ name: "task", arguments: { action: "status", id: "agent-1" } });
    expect(request[2]).toMatchObject({ role: "tool", toolCallId: request[1]?.toolCalls?.[0]?.id });
    expect(request[2]?.content).toContain("done: a");
    expect(request[2]?.content).toContain("not a message from the user");
    expect(request[3]?.content).toBe("please be brief");
    // The request ends on what the user just asked, so the model answers that.
    expect(request[4]?.content).toContain("summarise");
    expect(request.filter((message) => message.role === "user").some((message) => message.content.includes("done: a"))).toBe(false);

    const delivered = events.find((event) => event.type === "tool" && event.name === "subagent");
    expect(delivered).toMatchObject({ ok: true, metadata: { status: "ok", agent: "agent-1" } });
  });

  it("keeps an incomplete result as ok for the loop but says so in the metadata and to the model", async () => {
    const supervisor = await newSupervisor();
    supervisor.setSpawner(async function* () {
      yield { type: "final", message: "Half of it.", workState: "done", stoppedBy: "step_limit" };
    });
    supervisor.start(explore("a"));
    await until(() => supervisor.get("agent-1")?.state === "incomplete");

    const { client, seen } = routedClient([{ content: "Noted." }], []);
    const events = await drain((await mainRunner({ client, supervisor })).run("go"));

    expect(events.find((event) => event.type === "tool" && event.name === "subagent")).toMatchObject({ ok: true, metadata: { status: "incomplete" } });
    const text = toolResults(seen.main[0]?.messages ?? [])[0]?.content ?? "";
    expect(text).toContain("[incomplete]");
    expect(text).toContain("partial");
    expect(text).toContain('"message"');
  });

  it("keeps going when a reply has no tool calls but something is waiting", async () => {
    const supervisor = await newSupervisor();
    const { spawner, release } = gatedSpawner();
    supervisor.setSpawner(spawner);
    supervisor.start(explore("a"));

    const { client, seen } = routedClient([{ content: "First answer." }, { content: "Second answer." }], [], {
      beforeMain: async (call) => {
        if (call === 0) {
          release("a");
          await until(() => supervisor.get("agent-1")?.state === "ok");
        }
      }
    });
    const events = await drain((await mainRunner({ client, supervisor })).run("go"));

    expect(seen.main).toHaveLength(2);
    const second = seen.main[1]?.messages ?? [];
    expect(second.map((message) => message.role)).toEqual(["system", "user", "assistant", "assistant", "tool"]);
    expect(second[2]?.content).toBe("First answer.");
    expect(events.at(-1)).toMatchObject({ type: "final", message: "Second answer." });
  });

  it("continues on inbox text that arrives during a reply", async () => {
    let queued: string[] = [];
    const { client, seen } = routedClient([{ content: "One." }, { content: "Two." }], [], {
      beforeMain: async (call) => {
        if (call === 0) {
          queued = ["one more thing"];
        }
      }
    });
    const events = await drain(
      (await mainRunner({ client, inbox: () => queued.splice(0) })).run("go")
    );
    expect(seen.main[1]?.messages.at(-1)).toEqual({ role: "user", content: "one more thing" });
    expect(events.at(-1)).toMatchObject({ message: "Two." });
  });

  it("does not wake itself for a result nobody asked to be woken for", async () => {
    const supervisor = await newSupervisor();
    const { spawner, release } = gatedSpawner();
    supervisor.setSpawner(spawner);
    supervisor.start(explore("a"));
    release("a");
    await until(() => supervisor.get("agent-1")?.state === "ok");
    supervisor.takeFinished();
    supervisor.send("agent-1", "u", "user");
    release("u");
    await until(() => supervisor.get("agent-1")?.state === "ok");

    const { client, seen } = routedClient([{ content: "Answer." }], []);
    const events = await drain((await mainRunner({ client, supervisor })).run("go"));
    expect(seen.main).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "final" });
    expect(supervisor.takeFinished()).toHaveLength(0);
  });

  it("wakes with no new user message and ends on the delivered result", async () => {
    const supervisor = await newSupervisor();
    const conversation: ChatMessage[] = [];
    const { client, seen } = routedClient(
      [
        { toolCalls: [{ name: "task", arguments: { action: "start", description: "look", prompt: "CHILD look around", subagent_type: "explore" } }] },
        { content: "Started it, waiting." },
        { content: "The child found nothing." }
      ],
      [{ content: "Nothing there." }]
    );
    const runner = await mainRunner({ client, supervisor, conversation });
    await drain(runner.run("investigate"));
    await until(() => supervisor.hasWakeableResult());

    const events = await drain(runner.run("", { wake: true }));

    const request = seen.main.at(-1)?.messages ?? [];
    expect(request.at(-1)?.role).toBe("tool");
    expect(request.at(-1)?.content).toContain("Nothing there.");
    expect(request.filter((message) => message.role === "user")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "final", message: "The child found nothing." });
  });

  it("answers every task action in its own slot, listing the choices for an unknown id", async () => {
    const supervisor = await newSupervisor();
    const { client, seen } = routedClient(
      [
        {
          toolCalls: [
            { name: "task", arguments: { action: "start", description: "look", prompt: "CHILD look", subagent_type: "explore" } },
            { name: "task", arguments: { action: "status" } },
            { name: "task", arguments: { action: "message", id: "agent-1", prompt: "also the tests" } },
            { name: "task", arguments: { action: "message", id: "agent-9", prompt: "hi" } },
            { name: "task", arguments: { action: "stop", id: "agent-9" } },
            { name: "task", arguments: { action: "status", id: "agent-9" } },
            { name: "task", arguments: { action: "stop", id: "agent-1" } }
          ]
        },
        { content: "Done." }
      ],
      [{ content: "Looked." }]
    );
    await drain((await mainRunner({ client, supervisor })).run("go"));

    const results = toolResults(seen.main[1]?.messages ?? []).map((message) => message.content);
    expect(results).toHaveLength(7);
    expect(results[0]).toContain("Started agent-1 (explore): look. It runs in the background and its result reaches you automatically.");
    expect(results[1]).toContain("agent-1 (explore)");
    expect(results[2]).toContain("agent-1");
    for (const index of [3, 4, 5]) {
      expect(results[index]).toContain('No agent "agent-9". Known agents: agent-1.');
    }
    expect(results[6]).toMatch(/Stopped agent-1|already finished/);
  });

  it("starts children from one reply as one batch", async () => {
    const supervisor = await newSupervisor();
    const { spawner, release } = gatedSpawner();
    supervisor.setSpawner(spawner);
    const { client } = routedClient(
      [
        {
          toolCalls: [
            { name: "task", arguments: { action: "start", description: "a", prompt: "CHILD a", subagent_type: "explore" } },
            { name: "task", arguments: { action: "start", description: "b", prompt: "CHILD b", subagent_type: "explore" } }
          ]
        },
        { content: "Waiting." }
      ],
      [{ content: "A done." }, { content: "B done." }]
    );
    const runner = await mainRunner({ client, supervisor });
    await drain(runner.run("go"));
    await until(() => !supervisor.hasActive());
    release("unused");
    expect(supervisor.takeFinished().map((delivery) => delivery.id)).toEqual(["agent-1", "agent-2"]);
  });

  it("lets children run on when the main agent's signal aborts", async () => {
    const supervisor = await newSupervisor();
    const { spawner, contexts, release } = gatedSpawner();
    supervisor.setSpawner(spawner);
    supervisor.start(explore("a"));
    await until(() => contexts.length === 1);

    const controller = new AbortController();
    controller.abort();
    const { client } = routedClient([], []);
    const events = await drain((await mainRunner({ client, supervisor, signal: controller.signal })).run("go"));

    expect(events.at(-1)).toMatchObject({ type: "final", message: "Stopped." });
    expect(contexts[0]?.signal.aborted).toBe(false);
    expect(supervisor.get("agent-1")?.state).toBe("running");
    release("a");
    await until(() => supervisor.get("agent-1")?.state === "ok");
  });

  it("gives a background child its own signal and a labelled approval handler", async () => {
    const supervisor = await newSupervisor();
    const parent = new AbortController();
    const labels: Array<string | undefined> = [];
    const spawner = createChildSpawner({
      provider: "local-openai",
      model: "scripted",
      ollamaUrl: "http://127.0.0.1:1234/v1",
      workspace: await mkdtemp(path.join(tmpdir(), "pp-sup-ws-")),
      mode: "build",
      allowWrite: false,
      allowShell: false,
      maxSteps: 5,
      subagents: true,
      signal: parent.signal,
      shouldStopAfterStep: () => true,
      client: routedClient(
        [],
        [
          { toolCalls: [{ name: "write", arguments: { path: "x.txt", content: "x" } }] },
          { content: "wrote it" }
        ]
      ).client,
      approvalHandler: async (request) => {
        labels.push(request.agent);
        return "allow_once";
      }
    });
    setModelCapabilities("local-openai", "scripted", { nativeToolCalls: true, detail: "test" });
    supervisor.setSpawner(spawner);
    supervisor.start({ type: "general", description: "write", prompt: "CHILD write x" });
    parent.abort();
    await until(() => supervisor.get("agent-1")?.state === "ok");
    expect(labels).toEqual(["agent-1"]);
  });
});

describe("blocking path without a supervisor", () => {
  it("still runs the child to completion and returns its envelope", async () => {
    const { client, seen } = routedClient(
      [
        { toolCalls: [{ name: "task", arguments: { description: "look", prompt: "CHILD look", subagent_type: "explore" } }] },
        { content: "All good." }
      ],
      [{ content: "Looked, found nothing." }]
    );
    const events = await drain((await mainRunner({ client })).run("go"));
    const result = toolResults(seen.main[1]?.messages ?? [])[0]?.content ?? "";
    expect(result).toContain("[ok] look");
    expect(result).toContain("Looked, found nothing.");
    expect(events.at(-1)).toMatchObject({ type: "final", message: "All good." });
  });

  it("answers message, stop and status by saying no background agents exist", async () => {
    const { client, seen } = routedClient(
      [
        {
          toolCalls: [
            { name: "task", arguments: { action: "message", id: "agent-1", prompt: "hi" } },
            { name: "task", arguments: { action: "status" } }
          ]
        },
        { content: "Done." }
      ],
      []
    );
    await drain((await mainRunner({ client })).run("go"));
    const results = toolResults(seen.main[1]?.messages ?? []).map((message) => message.content);
    expect(results[0]).toContain("No background agents exist");
    expect(results[0]).toContain('action "start"');
    expect(results[1]).toContain("No background agents exist");
  });
});

describe("the step cap for children", () => {
  const glob = { name: "glob", arguments: { pattern: "*" } };

  it("makes one closing call without tools and reports the cap as a structured signal", async () => {
    const { client, seen } = routedClient([{ toolCalls: [glob] }, { toolCalls: [{ name: "glob", arguments: { pattern: "src/*" } }] }, { content: "Found A. B is missing." }], []);
    const events = await drain((await mainRunner({ client, closingCallOnCap: true, maxSteps: 2 })).run("go"));

    expect(seen.main).toHaveLength(3);
    expect(seen.main[2]?.tools).toBeUndefined();
    expect(seen.main[2]?.messages.at(-1)?.role).toBe("user");
    expect(seen.main[2]?.messages.at(-1)?.content).toContain("step");
    expect(events.at(-1)).toMatchObject({ type: "final", message: "Found A. B is missing.", stoppedBy: "step_limit" });
  });

  it("says the limit was reached without an answer when the closing call returns nothing", async () => {
    const { client } = routedClient([{ toolCalls: [glob] }, { toolCalls: [{ name: "glob", arguments: { pattern: "src/*" } }] }, { content: "" }], []);
    const events = await drain((await mainRunner({ client, closingCallOnCap: true, maxSteps: 2 })).run("go"));
    const last = events.at(-1);
    expect(last).toMatchObject({ type: "final", stoppedBy: "step_limit" });
    expect(last?.type === "final" ? last.message : "").toContain("without an answer");
  });

  it("leaves the main agent's pause message alone", async () => {
    const { client, seen } = routedClient([{ toolCalls: [glob] }, { toolCalls: [{ name: "glob", arguments: { pattern: "src/*" } }] }], []);
    const events = await drain((await mainRunner({ client, maxSteps: 2 })).run("go"));
    expect(seen.main).toHaveLength(2);
    const last = events.at(-1);
    expect(last?.type === "final" ? last.message : "").toContain("Paused after 2 steps");
    expect(last).not.toHaveProperty("stoppedBy");
  });
});
