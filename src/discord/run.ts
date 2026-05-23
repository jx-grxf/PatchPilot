import { ContextStore } from "../core/contextStore.js";
import { AgentRunner } from "../core/agent.js";
import { buildSessionResumeContext, SessionStore } from "../core/session.js";
import type { AgentEvent, ApprovalRequest, PermissionDecision } from "../core/types.js";
import type { PatchPilotDiscordConfig } from "./config.js";
import type { DiscordSessionKeyInput } from "./sessions.js";
import { findDiscordSessionRecord, upsertDiscordSessionRecord } from "./sessions.js";
import { emptyDiscordRunCounters, formatDiscordEvent, formatDiscordRunSummary, updateDiscordRunCounters, type DiscordRunCounters } from "./render.js";
import { writeDiscordRuntimeStatus } from "./status.js";

export type DiscordAgentMode = "plan" | "build" | "bypass";

export type RunDiscordAgentOptions = {
  config: PatchPilotDiscordConfig;
  prompt: string;
  workspace: string;
  source: DiscordSessionKeyInput;
  mode?: DiscordAgentMode;
  onEvent?: (event: AgentEvent, counters: DiscordRunCounters) => Promise<void>;
  approvalHandler?: (request: ApprovalRequest) => Promise<PermissionDecision>;
  signal?: AbortSignal;
};

export async function runDiscordAgent(options: RunDiscordAgentOptions): Promise<{
  sessionId: string;
  finalMessage: string;
  counters: DiscordRunCounters;
}> {
  const mode = options.mode ?? "plan";
  const existing = await findDiscordSessionRecord({
    stateDir: options.config.stateDir,
    input: options.source,
    workspace: options.workspace
  });
  const sessionStore = new SessionStore({
    workspace: options.workspace,
    sessionId: existing?.sessionId
  });
  if (!existing) {
    await sessionStore.create();
  }
  const contextStore = new ContextStore({
    workspace: options.workspace,
    sessionId: sessionStore.sessionId
  });
  await contextStore.bootstrapFromSession(await sessionStore.loadEvents()).catch(() => undefined);
  const resumeContext = existing ? await buildSessionResumeContext(options.workspace, sessionStore.sessionId).catch(() => "") : "";
  const persistedContext = await contextStore.buildContextBlock({
    maxItems: 12,
    title: "Known Discord session context"
  }).catch(() => "");
  const discordContext = [
    `Discord source: guild=${options.source.guildId ?? "dm"} channel=${options.source.channelId} thread=${options.source.threadId ?? "-"} user=${options.source.userId}`,
    "This run came from Discord. Keep secrets, tokens, cookies, and raw .env contents out of the Discord reply.",
    mode === "plan" ? "Discord plan mode is read-only." : mode === "build" ? "Discord build mode requires explicit approval for write/shell tools." : "Discord bypass mode was explicitly requested."
  ].join("\n");
  const runner = new AgentRunner({
    provider: options.config.provider,
    model: options.config.model,
    ollamaUrl: options.config.ollamaUrl,
    workspace: options.workspace,
    allowWrite: mode === "bypass",
    allowShell: mode === "bypass",
    maxSteps: options.config.maxSteps,
    thinkingMode: "adaptive",
    reasoningEffort: options.config.reasoningEffort,
    subagents: false,
    mode,
    signal: options.signal,
    sessionStore,
    resumeContext: [resumeContext, persistedContext, discordContext].filter(Boolean).join("\n\n"),
    allowExternalFileAnalysis: false,
    allowShellMetacharacters: false,
    memoryEnabled: false,
    approvalHandler: async (request) => {
      if (mode === "plan") {
        return "deny";
      }
      return options.approvalHandler ? await options.approvalHandler(request) : "deny";
    }
  });

  let finalMessage = "";
  let counters = emptyDiscordRunCounters();
  await upsertDiscordSessionRecord({
    stateDir: options.config.stateDir,
    input: options.source,
    sessionId: sessionStore.sessionId,
    workspace: options.workspace,
    prompt: options.prompt
  });

  for await (const event of runner.run(options.prompt)) {
    counters = updateDiscordRunCounters(counters, event);
    if (event.type === "final") {
      finalMessage = event.message;
    }
    await options.onEvent?.(event, counters);
  }

  await contextStore.append({
    kind: "turn",
    source: "user",
    label: options.prompt.replace(/\s+/g, " ").trim().slice(0, 120) || "Discord turn",
    text: [`Asked via Discord: ${options.prompt}`, finalMessage ? `Outcome: ${finalMessage.slice(0, 500)}` : ""].filter(Boolean).join("\n"),
    priority: 35
  }).catch(() => undefined);
  await upsertDiscordSessionRecord({
    stateDir: options.config.stateDir,
    input: options.source,
    sessionId: sessionStore.sessionId,
    workspace: options.workspace,
    prompt: options.prompt
  });
  await writeDiscordRuntimeStatus(options.config, {
    lastRun: {
      sessionId: sessionStore.sessionId,
      workspace: options.workspace,
      prompt: options.prompt.slice(0, 240),
      summary: formatDiscordRunSummary(counters),
      completedAt: new Date().toISOString()
    }
  }).catch(() => undefined);

  return {
    sessionId: sessionStore.sessionId,
    finalMessage: finalMessage || "PatchPilot finished without a final message.",
    counters
  };
}

export function shouldRelayDiscordEvent(event: AgentEvent): boolean {
  if (event.type === "metrics") {
    return false;
  }
  if (event.type === "status") {
    return /thinking|approval|error|stopped|complete/i.test(event.message);
  }
  return Boolean(formatDiscordEvent(event));
}
