import type { ContextItem, ContextItemKind } from "./contextItem.js";

export type ContextSnapshotView = {
  sessionId: string;
  items: ContextItem[];
  autoCompactionEnabled: boolean;
  updatedAt: string;
};

export type BuildContextBlockOptions = {
  maxItems?: number;
  includeDropped?: boolean;
  title?: string;
};

export function buildContextBlock(snapshot: ContextSnapshotView, options: BuildContextBlockOptions = {}): string {
  const title = options.title ?? "Known session context";
  const items = selectContextItems(snapshot.items, options)
    .map(formatContextLine)
    .filter(Boolean);

  if (items.length === 0) {
    return "";
  }

  return [`${title}:`, ...items].join("\n");
}

export function formatContextDashboard(snapshot: ContextSnapshotView): string {
  const activeItems = snapshot.items.filter((item) => !item.dropped);
  const pinnedItems = activeItems.filter((item) => item.pinned);
  const tokenEstimate = activeItems.reduce((total, item) => total + item.tokenEstimate, 0);
  const counts = countByKind(activeItems);
  const recentItems = activeItems
    .slice()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 8);

  return [
    `Context session: ${snapshot.sessionId}`,
    `Items: ${activeItems.length} active, ${pinnedItems.length} pinned, ~${tokenEstimate} tokens`,
    `Auto-compaction: ${snapshot.autoCompactionEnabled ? "on" : "off"}`,
    `Kinds: ${formatKindCounts(counts)}`,
    recentItems.length > 0 ? `Recent:\n${recentItems.map(formatDashboardLine).join("\n")}` : "Recent: none"
  ].join("\n");
}

export function summarizeContext(snapshot: ContextSnapshotView): {
  activeItems: number;
  pinnedItems: number;
  droppedItems: number;
  tokenEstimate: number;
  autoCompactionEnabled: boolean;
} {
  const active = snapshot.items.filter((item) => !item.dropped);
  return {
    activeItems: active.length,
    pinnedItems: active.filter((item) => item.pinned).length,
    droppedItems: snapshot.items.length - active.length,
    tokenEstimate: active.reduce((total, item) => total + item.tokenEstimate, 0),
    autoCompactionEnabled: snapshot.autoCompactionEnabled
  };
}

function selectContextItems(items: ContextItem[], options: BuildContextBlockOptions): ContextItem[] {
  return items
    .filter((item) => options.includeDropped || !item.dropped)
    .sort(compareContextPriority)
    .slice(0, options.maxItems ?? 16);
}

function compareContextPriority(left: ContextItem, right: ContextItem): number {
  if (left.pinned !== right.pinned) {
    return left.pinned ? -1 : 1;
  }

  if (left.priority !== right.priority) {
    return right.priority - left.priority;
  }

  return right.createdAt.localeCompare(left.createdAt);
}

function formatContextLine(item: ContextItem): string {
  const pin = item.pinned ? " pinned" : "";
  const path = item.path ? ` path=${item.path}` : "";
  const text = item.text ? ` note=${clip(item.text, 220)}` : "";
  return `- [${item.kind}${pin}] ${clip(item.label, 120)}${path}${text}`;
}

function formatDashboardLine(item: ContextItem): string {
  const pin = item.pinned ? " pinned" : "";
  const path = item.path ? ` (${item.path})` : "";
  return `- ${item.kind}${pin}: ${clip(item.label, 96)}${path}`;
}

function countByKind(items: ContextItem[]): Record<ContextItemKind, number> {
  return {
    turn: 0,
    attachment: 0,
    artifact: 0,
    tool_result: 0,
    pinned_file: 0,
    summary: 0,
    ...items.reduce<Partial<Record<ContextItemKind, number>>>((counts, item) => {
      counts[item.kind] = (counts[item.kind] ?? 0) + 1;
      return counts;
    }, {})
  };
}

function formatKindCounts(counts: Record<ContextItemKind, number>): string {
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${kind}=${count}`)
    .join(", ") || "none";
}

function clip(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}
