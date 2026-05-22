import { planCompaction } from "../core/compaction.js";
import { formatContextDashboard } from "../core/contextFormat.js";
import type { ContextItem } from "../core/contextItem.js";
import { ContextStore } from "../core/contextStore.js";
import type { LogLineInput } from "./types.js";

export type ContextSlashCommand = "context" | "compact";

export async function runContextSlashCommand(options: {
  workspace: string;
  sessionId: string;
  command: ContextSlashCommand;
  args: string[];
}): Promise<LogLineInput> {
  const store = new ContextStore({
    workspace: options.workspace,
    sessionId: options.sessionId
  });

  if (options.command === "context") {
    return await runContextCommand(store, options.workspace, options.sessionId, options.args);
  }

  return await runCompactCommand(store, options.args);
}

async function runContextCommand(store: ContextStore, workspace: string, sessionId: string, args: string[]): Promise<LogLineInput> {
  const action = normalizeContextAction(args[0]);
  const snapshot = await store.snapshot();
  const activeItems = snapshot.items.filter((item) => !item.dropped);

  switch (action) {
    case "show":
      return {
        kind: "status",
        tone: activeItems.length > 0 ? "accent" : "muted",
        label: "context",
        text: activeItems.length > 0 ? `Context has ${activeItems.length} active item${activeItems.length === 1 ? "" : "s"}.` : "No active saved context for this session.",
        detail: formatContextDashboard(snapshot)
      };
    case "files": {
      const items = activeItems.filter((item) => item.path || item.kind === "attachment" || item.kind === "artifact" || item.kind === "pinned_file");
      return {
        kind: "status",
        tone: items.length > 0 ? "accent" : "muted",
        label: "context",
        text: items.length > 0 ? `Found ${items.length} path-backed context item${items.length === 1 ? "" : "s"}.` : "No path-backed context items.",
        detail: formatItemList(items)
      };
    }
    case "pins": {
      const items = activeItems.filter((item) => item.pinned);
      return {
        kind: "status",
        tone: items.length > 0 ? "accent" : "muted",
        label: "context",
        text: items.length > 0 ? `Found ${items.length} pinned context item${items.length === 1 ? "" : "s"}.` : "No pinned context items.",
        detail: formatItemList(items)
      };
    }
    case "clear": {
      const clearableCount = activeItems.filter((item) => !item.pinned).length;
      await store.clear({
        includePinned: false
      });
      return {
        kind: "status",
        tone: clearableCount > 0 ? "success" : "muted",
        label: "context",
        text: clearableCount > 0 ? `Cleared ${clearableCount} unpinned context item${clearableCount === 1 ? "" : "s"}.` : "No unpinned context items to clear.",
        detail: "Pinned context remains active."
      };
    }
    case "export": {
      const exportSnapshot = await store.snapshot();
      const snapshotPath = ContextStore.workspaceSnapshotPath(workspace, sessionId);
      return {
        kind: "status",
        tone: "accent",
        label: "context",
        text: `Context snapshot exported to ${snapshotPath}.`,
        detail: JSON.stringify(exportSnapshot, null, 2)
      };
    }
  }
}

async function runCompactCommand(store: ContextStore, args: string[]): Promise<LogLineInput> {
  const action = normalizeCompactAction(args[0]);

  switch (action) {
    case "auto": {
      const enabled = normalizeAutoCompactionValue(args[0]?.toLowerCase() === "on" || args[0]?.toLowerCase() === "off" ? args[0] : args[1]);
      await store.setAutoCompaction(enabled);
      return {
        kind: "status",
        tone: "success",
        label: "compact",
        text: `Automatic context compaction ${enabled ? "enabled" : "disabled"}.`
      };
    }
    case "reset":
      await store.resetSummaries();
      await store.setAutoCompaction(false);
      return {
        kind: "status",
        tone: "success",
        label: "compact",
        text: "Context compaction summaries reset and auto-compaction disabled."
      };
    case "now":
      return await compactNow(store);
  }
}

async function compactNow(store: ContextStore): Promise<LogLineInput> {
  const snapshot = await store.snapshot();
  const activeItems = snapshot.items.filter((item) => !item.dropped);
  const plan = planCompaction(activeItems, {
    targetTokens: 0,
    minItemsToCompact: 1
  });
  const summarizedItems = plan.summarize.map((entry) => entry.item);
  const droppedItems = plan.drop.map((entry) => entry.item);
  const itemIds = [...new Set([...summarizedItems, ...droppedItems].map((item) => item.id))];

  if (itemIds.length === 0) {
    return {
      kind: "status",
      tone: "muted",
      label: "compact",
      text: "No eligible unpinned context items to compact.",
      detail: formatCompactionPlan(plan.keep.map((entry) => entry.item), "Kept")
    };
  }

  if (summarizedItems.length > 0) {
    await store.recordSummary({
      label: "manual context compaction",
      text: summarizedItems.map((item) => `${item.kind}: ${item.label}${item.text ? ` - ${clip(item.text, 180)}` : ""}`).join("\n"),
      tokenEstimate: summarizedItems.reduce((total, item) => total + Math.min(item.tokenEstimate, 80), 0),
      priority: 60
    });
  }

  for (const itemId of itemIds) {
    await store.drop(itemId);
  }

  return {
    kind: "status",
    tone: "success",
    label: "compact",
    text: `Compacted ${itemIds.length} context item${itemIds.length === 1 ? "" : "s"}.`,
    detail: [
      `Summarized: ${summarizedItems.length}`,
      `Dropped: ${droppedItems.length}`,
      `Kept: ${plan.keep.length}`,
      plan.blockedSecrets.length > 0 ? `Secret-like items dropped without summary: ${plan.blockedSecrets.length}` : ""
    ]
      .filter(Boolean)
      .join("\n")
  };
}

function normalizeContextAction(value: string | undefined): "show" | "files" | "pins" | "clear" | "export" {
  switch (value?.toLowerCase()) {
    case undefined:
    case "":
    case "show":
    case "list":
      return "show";
    case "files":
    case "file":
      return "files";
    case "pins":
    case "pin":
    case "pinned":
      return "pins";
    case "clear":
      return "clear";
    case "export":
      return "export";
    default:
      return "show";
  }
}

function normalizeCompactAction(value: string | undefined): "now" | "auto" | "reset" {
  switch (value?.toLowerCase()) {
    case "auto":
    case "on":
    case "off":
      return "auto";
    case "reset":
      return "reset";
    case undefined:
    case "":
    case "now":
    default:
      return "now";
  }
}

function normalizeAutoCompactionValue(value: string | undefined): boolean {
  if (value?.toLowerCase() === "off" || value?.toLowerCase() === "false" || value === "0") {
    return false;
  }

  return true;
}

function formatItemList(items: ContextItem[]): string {
  if (items.length === 0) {
    return "none";
  }

  return items
    .slice(0, 12)
    .map((item, index) => `${index + 1}. ${item.kind}${item.pinned ? " pinned" : ""}: ${clip(item.label, 96)}${item.path ? ` (${item.path})` : ""}`)
    .join("\n");
}

function formatCompactionPlan(items: ContextItem[], title: string): string {
  if (items.length === 0) {
    return `${title}: none`;
  }

  return `${title}:\n${formatItemList(items)}`;
}

function clip(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}
