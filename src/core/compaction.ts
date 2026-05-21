import type { ContextItem } from "./contextItem.js";
import { isSensitivePath } from "./workspace.js";

export type CompactionPressure = "ok" | "compact" | "critical";

export type CompactionPlanOptions = {
  targetTokens: number;
  currentTask?: string;
  minItemsToCompact?: number;
  now?: string;
};

export type PlannedCompactionItem = {
  item: ContextItem;
  reason: string;
};

export type CompactionPlan = {
  pressure: CompactionPressure;
  usedTokens: number;
  targetTokens: number;
  keep: PlannedCompactionItem[];
  summarize: PlannedCompactionItem[];
  drop: PlannedCompactionItem[];
  blockedSecrets: PlannedCompactionItem[];
};

export function planCompaction(items: ContextItem[], options: CompactionPlanOptions): CompactionPlan {
  const activeItems = items.filter((item) => !item.dropped);
  const usedTokens = activeItems.reduce((total, item) => total + item.tokenEstimate, 0);
  const targetTokens = Math.max(0, Math.floor(options.targetTokens));
  const pressure: CompactionPressure = usedTokens <= targetTokens ? "ok" : usedTokens >= targetTokens * 1.25 ? "critical" : "compact";
  const minItemsToCompact = options.minItemsToCompact ?? 4;
  const currentTask = options.currentTask ?? "";
  const keep: PlannedCompactionItem[] = [];
  const summarize: PlannedCompactionItem[] = [];
  const drop: PlannedCompactionItem[] = [];
  const blockedSecrets: PlannedCompactionItem[] = [];

  for (const item of activeItems) {
    if (mustKeep(item, currentTask)) {
      keep.push({
        item,
        reason: item.pinned ? "pinned context is never compacted away" : "referenced attachment or artifact path must remain exact"
      });
      continue;
    }

    if (itemContainsSecret(item)) {
      blockedSecrets.push({
        item,
        reason: "secret-like context is excluded from durable summaries"
      });
      drop.push({
        item,
        reason: "secret-like context can be dropped from prompt pressure but not summarized"
      });
      continue;
    }

    if (pressure === "ok" || activeItems.length < minItemsToCompact) {
      keep.push({
        item,
        reason: "context is within budget"
      });
      continue;
    }

    if (shouldSummarize(item)) {
      summarize.push({
        item,
        reason: summaryReason(item)
      });
      continue;
    }

    drop.push({
      item,
      reason: dropReason(item)
    });
  }

  drop.sort(compareDropOrder);
  summarize.sort(compareDropOrder);

  return {
    pressure,
    usedTokens,
    targetTokens,
    keep,
    summarize,
    drop,
    blockedSecrets
  };
}

export function isSecretLikeText(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) {
    return false;
  }

  return secretTextPatterns.some((pattern) => pattern.test(normalized));
}

function mustKeep(item: ContextItem, currentTask: string): boolean {
  if (item.pinned) {
    return true;
  }

  if ((item.kind === "attachment" || item.kind === "artifact" || item.kind === "pinned_file") && item.path && currentTask.includes(item.path)) {
    return true;
  }

  return false;
}

function itemContainsSecret(item: ContextItem): boolean {
  return Boolean(
    (item.path && isSensitivePath(item.path)) ||
      (item.text && isSecretLikeText(item.text)) ||
      isSecretLikeText(item.label) ||
      Object.values(item.meta ?? {}).some((value) => typeof value === "string" && isSecretLikeText(value))
  );
}

function shouldSummarize(item: ContextItem): boolean {
  return item.kind === "turn" || item.kind === "summary" || (item.kind === "tool_result" && item.priority >= 40);
}

function summaryReason(item: ContextItem): string {
  if (item.kind === "tool_result") {
    return "failed or important tool result is useful historical context";
  }

  return "older prose can be summarized into durable session context";
}

function dropReason(item: ContextItem): string {
  switch (item.kind) {
    case "tool_result":
      return "old successful tool logs are the first pressure drop";
    case "artifact":
      return "unpinned artifact can be re-read from its path if needed";
    case "attachment":
      return "unpinned attachment metadata is lower priority than pinned context";
    case "summary":
      return "superseded summary can be regenerated";
    case "turn":
      return "old unpinned turn can be compacted under pressure";
    case "pinned_file":
      return "unpinned file metadata can be re-read";
  }
}

function compareDropOrder(left: PlannedCompactionItem, right: PlannedCompactionItem): number {
  const leftRank = dropRank(left.item);
  const rightRank = dropRank(right.item);
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }

  if (left.item.priority !== right.item.priority) {
    return left.item.priority - right.item.priority;
  }

  return left.item.createdAt.localeCompare(right.item.createdAt);
}

function dropRank(item: ContextItem): number {
  if (item.kind === "tool_result" && item.priority < 40) {
    return 1;
  }

  if (item.kind === "turn" && item.source === "assistant") {
    return 2;
  }

  if (item.kind === "turn") {
    return 3;
  }

  if (item.kind === "artifact") {
    return 4;
  }

  if (item.kind === "summary") {
    return 5;
  }

  return 6;
}

const secretTextPatterns = [
  /\b[A-Z0-9_]*(API|ACCESS|AUTH|BEARER|CLIENT|REFRESH|SECRET|SESSION|TOKEN)[A-Z0-9_]*\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}/i,
  /\b(?:sk|pk|rk|ghp|github_pat|glpat|xox[baprs])-?[A-Za-z0-9_]{16,}\b/i,
  /\bAIza[0-9A-Za-z_-]{20,}\b/,
  /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/
];
