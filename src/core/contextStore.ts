import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildContextBlock as formatContextBlock } from "./contextFormat.js";
import { createContextItem, isContextItem, normalizeContextItem, type ContextItem, type ContextItemInput, type ContextItemKind } from "./contextItem.js";
import type { SessionEvent } from "./types.js";

export type ContextSnapshot = {
  version: 1;
  sessionId: string;
  updatedAt: string;
  eventCount: number;
  autoCompactionEnabled: boolean;
  items: ContextItem[];
};

type ContextLogRecord =
  | {
      type: "context.item.appended";
      item: ContextItem;
      createdAt: string;
    }
  | {
      type: "context.item.pinned";
      itemId: string;
      pinned: boolean;
      createdAt: string;
    }
  | {
      type: "context.item.dropped";
      itemId: string;
      createdAt: string;
    }
  | {
      type: "context.cleared";
      includePinned: boolean;
      kinds?: ContextItemKind[];
      createdAt: string;
    }
  | {
      type: "context.summaries.reset";
      createdAt: string;
    }
  | {
      type: "context.auto_compaction.set";
      enabled: boolean;
      createdAt: string;
    };

type ReplayResult = {
  snapshot: ContextSnapshot;
  recordCount: number;
};

export class ContextStore {
  readonly workspace: string;
  readonly sessionId: string;
  private readonly contextDir: string;
  private readonly logPath: string;
  private readonly snapshotPath: string;

  constructor(options: { workspace: string; sessionId: string }) {
    this.workspace = path.resolve(options.workspace);
    this.sessionId = options.sessionId;
    this.contextDir = path.join(this.workspace, ".patchpilot", "context");
    this.logPath = path.join(this.contextDir, `${this.sessionId}.jsonl`);
    this.snapshotPath = path.join(this.contextDir, `${this.sessionId}.snapshot.json`);
  }

  static workspaceContextPath(workspace: string, sessionId: string): string {
    return path.join(path.resolve(workspace), ".patchpilot", "context", `${sessionId}.jsonl`);
  }

  static workspaceSnapshotPath(workspace: string, sessionId: string): string {
    return path.join(path.resolve(workspace), ".patchpilot", "context", `${sessionId}.snapshot.json`);
  }

  async append(input: ContextItemInput | ContextItem): Promise<ContextItem> {
    const item = isContextItem(input) ? normalizeContextItem(input) : createContextItem(input);
    await this.appendRecord({
      type: "context.item.appended",
      item,
      createdAt: new Date().toISOString()
    });
    return item;
  }

  async loadItems(): Promise<ContextItem[]> {
    return (await this.snapshot()).items;
  }

  async snapshot(): Promise<ContextSnapshot> {
    const records = await this.readRecords();
    const cached = await this.readSnapshot();
    if (cached && cached.eventCount === records.length) {
      return cached;
    }

    const replayed = replayRecords(this.sessionId, records);
    await this.writeSnapshot(replayed.snapshot);
    return replayed.snapshot;
  }

  async pin(itemId: string): Promise<void> {
    await this.appendRecord({
      type: "context.item.pinned",
      itemId,
      pinned: true,
      createdAt: new Date().toISOString()
    });
  }

  async unpin(itemId: string): Promise<void> {
    await this.appendRecord({
      type: "context.item.pinned",
      itemId,
      pinned: false,
      createdAt: new Date().toISOString()
    });
  }

  async drop(itemId: string): Promise<void> {
    await this.appendRecord({
      type: "context.item.dropped",
      itemId,
      createdAt: new Date().toISOString()
    });
  }

  async clear(options: { includePinned?: boolean; kinds?: ContextItemKind[] } = {}): Promise<void> {
    await this.appendRecord({
      type: "context.cleared",
      includePinned: options.includePinned ?? false,
      kinds: options.kinds,
      createdAt: new Date().toISOString()
    });
  }

  async recordSummary(input: Omit<ContextItemInput, "kind" | "source"> & { source?: string }): Promise<ContextItem> {
    return await this.append({
      ...input,
      kind: "summary",
      source: input.source ?? "session",
      priority: input.priority ?? 60
    });
  }

  async resetSummaries(): Promise<void> {
    await this.appendRecord({
      type: "context.summaries.reset",
      createdAt: new Date().toISOString()
    });
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    await this.appendRecord({
      type: "context.auto_compaction.set",
      enabled,
      createdAt: new Date().toISOString()
    });
  }

  async buildContextBlock(options: { maxItems?: number; includeDropped?: boolean; title?: string } = {}): Promise<string> {
    return formatContextBlock(await this.snapshot(), options);
  }

  async bootstrapFromSession(events: SessionEvent[]): Promise<ContextItem[]> {
    const existingKeys = new Set((await this.loadItems()).map((item) => item.meta?.sessionEventKey).filter((value): value is string => typeof value === "string"));
    const created: ContextItem[] = [];

    for (const event of events) {
      const input = contextItemFromSessionEvent(event);
      if (!input) {
        continue;
      }
      const sessionEventKey = input?.meta?.sessionEventKey;
      if (typeof sessionEventKey !== "string" || existingKeys.has(sessionEventKey)) {
        continue;
      }

      const item = await this.append(input);
      existingKeys.add(sessionEventKey);
      created.push(item);
    }

    return created;
  }

  private async appendRecord(record: ContextLogRecord): Promise<void> {
    await mkdir(this.contextDir, {
      recursive: true
    });
    await appendFile(this.logPath, `${JSON.stringify(record)}\n`, "utf8");
    const replayed = replayRecords(this.sessionId, await this.readRecords());
    await this.writeSnapshot(replayed.snapshot);
  }

  private async readRecords(): Promise<ContextLogRecord[]> {
    const content = await readFile(this.logPath, "utf8").catch(() => "");
    return content
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as unknown;
          return isContextLogRecord(parsed) ? [parsed] : [];
        } catch {
          return [];
        }
      });
  }

  private async readSnapshot(): Promise<ContextSnapshot | null> {
    const content = await readFile(this.snapshotPath, "utf8").catch(() => "");
    if (!content.trim()) {
      return null;
    }

    try {
      const parsed = JSON.parse(content) as unknown;
      return isContextSnapshot(parsed, this.sessionId) ? parsed : null;
    } catch {
      return null;
    }
  }

  private async writeSnapshot(snapshot: ContextSnapshot): Promise<void> {
    await mkdir(this.contextDir, {
      recursive: true
    });
    await writeFile(this.snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  }
}

function replayRecords(sessionId: string, records: ContextLogRecord[]): ReplayResult {
  const items = new Map<string, ContextItem>();
  let autoCompactionEnabled = false;
  let updatedAt = new Date(0).toISOString();

  for (const record of records) {
    updatedAt = record.createdAt;
    switch (record.type) {
      case "context.item.appended":
        items.set(record.item.id, normalizeContextItem(record.item));
        break;
      case "context.item.pinned":
        patchItem(items, record.itemId, {
          pinned: record.pinned
        });
        break;
      case "context.item.dropped":
        patchItem(items, record.itemId, {
          dropped: true
        });
        break;
      case "context.cleared":
        for (const item of items.values()) {
          if ((record.includePinned || !item.pinned) && (!record.kinds || record.kinds.includes(item.kind))) {
            item.dropped = true;
          }
        }
        break;
      case "context.summaries.reset":
        for (const item of items.values()) {
          if (item.kind === "summary") {
            item.dropped = true;
          }
        }
        break;
      case "context.auto_compaction.set":
        autoCompactionEnabled = record.enabled;
        break;
    }
  }

  return {
    recordCount: records.length,
    snapshot: {
      version: 1,
      sessionId,
      updatedAt,
      eventCount: records.length,
      autoCompactionEnabled,
      items: [...items.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    }
  };
}

function patchItem(items: Map<string, ContextItem>, itemId: string, patch: Partial<ContextItem>): void {
  const item = items.get(itemId);
  if (!item) {
    return;
  }

  items.set(itemId, {
    ...item,
    ...patch
  });
}

function contextItemFromSessionEvent(event: SessionEvent): ContextItemInput | null {
  switch (event.type) {
    case "run.started":
      return {
        kind: "turn",
        source: "user",
        label: event.task,
        text: event.task,
        runId: event.runId,
        createdAt: event.startedAt,
        meta: {
          sessionEventKey: `${event.type}:${event.runId}`
        }
      };
    case "run.completed":
      return {
        kind: "turn",
        source: "assistant",
        label: "assistant response",
        text: event.message,
        runId: event.runId,
        createdAt: event.completedAt,
        meta: {
          sessionEventKey: `${event.type}:${event.runId}`
        }
      };
    case "tool.completed":
      return {
        kind: "tool_result",
        source: "tool",
        label: `${event.tool} ${event.ok ? "ok" : "failed"}`,
        text: event.summary,
        runId: event.runId,
        createdAt: event.createdAt,
        priority: event.ok ? 20 : 45,
        meta: {
          sessionEventKey: `${event.type}:${event.toolCallId}`,
          tool: event.tool,
          ok: event.ok
        }
      };
    default:
      return null;
  }
}

function isContextSnapshot(value: unknown, sessionId: string): value is ContextSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<ContextSnapshot>;
  return (
    candidate.version === 1 &&
    candidate.sessionId === sessionId &&
    typeof candidate.updatedAt === "string" &&
    typeof candidate.eventCount === "number" &&
    typeof candidate.autoCompactionEnabled === "boolean" &&
    Array.isArray(candidate.items) &&
    candidate.items.every(isContextItem)
  );
}

function isContextLogRecord(value: unknown): value is ContextLogRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<ContextLogRecord>;
  if (typeof candidate.type !== "string" || typeof candidate.createdAt !== "string") {
    return false;
  }

  switch (candidate.type) {
    case "context.item.appended":
      return isContextItem(candidate.item);
    case "context.item.pinned":
      return typeof candidate.itemId === "string" && typeof candidate.pinned === "boolean";
    case "context.item.dropped":
      return typeof candidate.itemId === "string";
    case "context.cleared":
      return typeof candidate.includePinned === "boolean" && (candidate.kinds === undefined || Array.isArray(candidate.kinds));
    case "context.summaries.reset":
      return true;
    case "context.auto_compaction.set":
      return typeof candidate.enabled === "boolean";
    default:
      return false;
  }
}
