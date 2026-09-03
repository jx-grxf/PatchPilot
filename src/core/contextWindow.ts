import { estimateTokens } from "./tokenAccounting.js";
import type { ChatMessage } from "./types.js";

/**
 * Conversation-level context management.
 *
 * Two separate passes, deliberately: **prune** discards the bodies of old tool
 * results, **compact** summarises the conversation itself. Tool output is what
 * actually floods a small context window and it is the cheapest thing to throw
 * away, so pruning runs first and often, and compaction only when pruning is
 * no longer enough.
 *
 * Summarising everything at 92% — the hosted-agent approach — is the wrong
 * shape for an 8k window: by the time it fires there is no room left to think,
 * and a single tool result can blow the budget in one step.
 */

export type ContextBudget = {
  /** The model's real context window, from the runtime rather than what we sent. */
  limitTokens: number;
  /** Tokens reserved for the reply. */
  reserveTokens: number;
};

export type ContextUsage = {
  usedTokens: number;
  limitTokens: number;
  /** 0–1, of the usable window rather than the raw limit. */
  ratio: number;
  pressure: "ok" | "warn" | "high" | "critical";
};

/** Tool output younger than this stays verbatim; older output may be pruned. */
export const protectedToolResultTokens = 4000;

/** Below this there is nothing worth pruning, so the pass is skipped. */
export const minimumPrunableTokens = 1500;

export function measureContext(messages: ChatMessage[], budget: ContextBudget): ContextUsage {
  const usedTokens = totalTokens(messages);
  const usable = Math.max(1, budget.limitTokens - budget.reserveTokens);
  const ratio = usedTokens / usable;

  return {
    usedTokens,
    limitTokens: budget.limitTokens,
    ratio,
    pressure: ratio >= 1 ? "critical" : ratio >= 0.85 ? "high" : ratio >= 0.7 ? "warn" : "ok"
  };
}

export function totalTokens(messages: ChatMessage[]): number {
  return messages.reduce((total, message) => total + estimateTokens(message.content), 0);
}

/**
 * Replaces the bodies of older tool results with one-line summaries, keeping
 * the most recent output verbatim. The model needs detail about what it just
 * did; what it did twenty steps ago only needs to be recognisable.
 */
export function pruneToolResults(
  messages: ChatMessage[],
  options: { protectTokens?: number; minimumPrunable?: number } = {}
): { messages: ChatMessage[]; prunedTokens: number; prunedCount: number } {
  const protectTokens = options.protectTokens ?? protectedToolResultTokens;
  const minimumPrunable = options.minimumPrunable ?? minimumPrunableTokens;

  const indices: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (isToolResultMessage(messages[index])) {
      indices.push(index);
    }
  }

  // Walk backwards so the newest results fill the protected budget first. The
  // most recent result is always kept whole — the model needs to see what it
  // just did, however large that was — but older ones are only protected while
  // they still fit, so one big result cannot drag the whole history along.
  let protectedSoFar = 0;
  const prunable: number[] = [];
  for (let position = indices.length - 1; position >= 0; position -= 1) {
    const index = indices[position];
    if (index === undefined) {
      continue;
    }

    const tokens = estimateTokens(messages[index]?.content ?? "");
    const isNewest = position === indices.length - 1;
    if (isNewest || protectedSoFar + tokens <= protectTokens) {
      protectedSoFar += tokens;
      continue;
    }

    prunable.push(index);
  }

  const prunableTokens = prunable.reduce((total, index) => total + estimateTokens(messages[index]?.content ?? ""), 0);
  if (prunableTokens < minimumPrunable) {
    return { messages, prunedTokens: 0, prunedCount: 0 };
  }

  const pruneSet = new Set(prunable);
  const next = messages.map((message, index) =>
    pruneSet.has(index) ? { ...message, content: summariseToolResult(message.content) } : message
  );

  return {
    messages: next,
    prunedTokens: prunableTokens - prunable.reduce((total, index) => total + estimateTokens(next[index]?.content ?? ""), 0),
    prunedCount: prunable.length
  };
}

/**
 * Everything the conversation needs to survive a compaction. Kept as data so
 * the caller decides which model summarises — a small local model should not
 * spend its own window doing it.
 */
export type CompactionRequest = {
  /** Messages to replace with a summary. */
  stale: ChatMessage[];
  /** Messages kept verbatim: the system prompt and the recent tail. */
  kept: ChatMessage[];
};

/**
 * Splits a conversation into what can be summarised and what must survive
 * intact. The system prompt always survives; so does a recent tail, because a
 * summary of the step you are in the middle of is useless.
 */
export function planCompaction(messages: ChatMessage[], options: { keepTailTokens: number }): CompactionRequest {
  const systemMessages = messages.filter((message) => message.role === "system");
  const rest = messages.filter((message) => message.role !== "system");

  const kept: ChatMessage[] = [];
  let keptTokens = 0;
  for (let index = rest.length - 1; index >= 0; index -= 1) {
    const message = rest[index];
    if (!message) {
      continue;
    }

    if (keptTokens >= options.keepTailTokens && kept.length > 0) {
      return { stale: rest.slice(0, index + 1), kept: [...systemMessages, ...kept] };
    }

    keptTokens += estimateTokens(message.content);
    kept.unshift(message);
  }

  return { stale: [], kept: messages };
}

/** Builds the instruction used to summarise a stale conversation segment. */
export function buildCompactionPrompt(stale: ChatMessage[]): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "Summarise the following agent transcript so work can continue without it. Record: what was accomplished, what is still in progress, which files were touched, concrete next steps, and any constraint the user stated. Keep every file path and identifier verbatim. Omit tool output that no longer matters. Write prose, not JSON."
    },
    {
      role: "user",
      content: stale.map((message) => `[${message.role}] ${message.content}`).join("\n\n")
    }
  ];
}

/** Splices a summary back in where the stale segment was. */
export function applyCompaction(request: CompactionRequest, summary: string): ChatMessage[] {
  if (request.stale.length === 0) {
    return request.kept;
  }

  const systemMessages = request.kept.filter((message) => message.role === "system");
  const tail = request.kept.filter((message) => message.role !== "system");

  return [
    ...systemMessages,
    {
      role: "user",
      content: `Summary of earlier work in this session:\n\n${summary.trim()}`
    },
    ...tail
  ];
}

/**
 * Tool results reach the model as a short prose preamble followed by a JSON
 * payload, so the marker is matched anywhere in the leading section rather
 * than anchored to the first character.
 */
function isToolResultMessage(message: ChatMessage | undefined): boolean {
  return message?.role === "user" && message.content.slice(0, 400).includes('"tool_results"');
}

/**
 * Keeps the shape of a result — which tool, and whether it worked — while
 * dropping the body. A model that sees "read_file ok" knows it already read
 * the file; it does not need the contents again.
 */
function summariseToolResult(content: string): string {
  const summaries: string[] = [];
  try {
    const jsonStart = content.indexOf('{"tool_results"');
    const parsed = JSON.parse(jsonStart === -1 ? content : content.slice(jsonStart)) as {
      tool_results?: Array<{ tool?: string; ok?: boolean; summary?: string }>;
    };
    for (const result of parsed.tool_results ?? []) {
      summaries.push(`${result.tool ?? "tool"} ${result.ok === false ? "failed" : "ok"}: ${clip(result.summary ?? "", 120)}`);
    }
  } catch {
    return `[pruned earlier tool output, ${estimateTokens(content)} tokens]`;
  }

  return summaries.length > 0
    ? `[pruned earlier tool output] ${summaries.join(" · ")}`
    : `[pruned earlier tool output, ${estimateTokens(content)} tokens]`;
}

function clip(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}
