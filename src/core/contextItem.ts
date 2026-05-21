import { estimateTokens } from "./tokenAccounting.js";

export type ContextItemKind = "turn" | "attachment" | "artifact" | "tool_result" | "pinned_file" | "summary";

export type ContextItemSource = "user" | "assistant" | "tool" | "system" | "session";

export type ContextItemMeta = Record<string, boolean | number | string | string[] | null>;

export type ContextItem = {
  id: string;
  kind: ContextItemKind;
  source: ContextItemSource | string;
  label: string;
  path?: string;
  text?: string;
  createdAt: string;
  runId?: string;
  tokenEstimate: number;
  priority: number;
  pinned: boolean;
  dropped: boolean;
  expiresAfterTurns?: number;
  meta?: ContextItemMeta;
};

export type ContextItemInput = {
  id?: string;
  kind: ContextItemKind;
  source: ContextItemSource | string;
  label: string;
  path?: string;
  text?: string;
  createdAt?: string;
  runId?: string;
  tokenEstimate?: number;
  priority?: number;
  pinned?: boolean;
  dropped?: boolean;
  expiresAfterTurns?: number;
  meta?: ContextItemMeta;
};

export function createContextItem(input: ContextItemInput): ContextItem {
  return normalizeContextItem({
    id: input.id ?? createContextItemId(input.kind),
    kind: input.kind,
    source: input.source,
    label: input.label,
    path: input.path,
    text: input.text,
    createdAt: input.createdAt ?? new Date().toISOString(),
    runId: input.runId,
    tokenEstimate: input.tokenEstimate,
    priority: input.priority,
    pinned: input.pinned,
    dropped: input.dropped,
    expiresAfterTurns: input.expiresAfterTurns,
    meta: input.meta
  });
}

export function normalizeContextItem(input: ContextItemInput & { id: string }): ContextItem {
  const label = input.label.trim() || input.path?.trim() || input.kind;
  const text = cleanOptionalString(input.text);
  const itemPath = cleanOptionalString(input.path);
  const estimatedTokens = input.tokenEstimate ?? estimateTokens([label, itemPath, text].filter(Boolean).join("\n"));

  return {
    id: input.id.trim() || createContextItemId(input.kind),
    kind: input.kind,
    source: input.source.trim() || "session",
    label,
    path: itemPath,
    text,
    createdAt: input.createdAt ?? new Date().toISOString(),
    runId: cleanOptionalString(input.runId),
    tokenEstimate: Math.max(0, Math.ceil(estimatedTokens)),
    priority: clampPriority(input.priority ?? defaultPriority(input.kind)),
    pinned: input.pinned ?? input.kind === "pinned_file",
    dropped: input.dropped ?? false,
    expiresAfterTurns: input.expiresAfterTurns === undefined ? undefined : Math.max(0, Math.floor(input.expiresAfterTurns)),
    meta: input.meta
  };
}

export function isContextItemKind(value: unknown): value is ContextItemKind {
  return (
    value === "turn" ||
    value === "attachment" ||
    value === "artifact" ||
    value === "tool_result" ||
    value === "pinned_file" ||
    value === "summary"
  );
}

export function isContextItem(value: unknown): value is ContextItem {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<ContextItem>;
  return (
    typeof candidate.id === "string" &&
    isContextItemKind(candidate.kind) &&
    typeof candidate.source === "string" &&
    typeof candidate.label === "string" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.tokenEstimate === "number" &&
    typeof candidate.priority === "number" &&
    typeof candidate.pinned === "boolean" &&
    typeof candidate.dropped === "boolean"
  );
}

function defaultPriority(kind: ContextItemKind): number {
  switch (kind) {
    case "pinned_file":
      return 100;
    case "attachment":
    case "artifact":
      return 80;
    case "summary":
      return 60;
    case "turn":
      return 40;
    case "tool_result":
      return 20;
  }
}

function clampPriority(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round(value)));
}

function cleanOptionalString(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned ? cleaned : undefined;
}

function createContextItemId(kind: ContextItemKind): string {
  return `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
