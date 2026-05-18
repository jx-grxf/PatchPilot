import { rm } from "node:fs/promises";
import path from "node:path";

export type CleanupTarget = "cache" | "sessions" | "temp" | "all";

export async function cleanupPatchPilot(workspace: string, target: CleanupTarget): Promise<string[]> {
  const root = path.resolve(workspace);
  const targets: Array<{ label: string; path: string }> = [];

  if (target === "cache" || target === "all") {
    targets.push({ label: "workspace cache", path: path.join(root, ".patchpilot", "cache") });
  }

  if (target === "sessions" || target === "all") {
    targets.push({ label: "workspace sessions", path: path.join(root, ".patchpilot", "sessions") });
  }

  if (target === "temp" || target === "all") {
    targets.push({ label: "workspace temp", path: path.join(root, ".patchpilot", "tmp") });
  }

  const removed: string[] = [];
  for (const item of targets) {
    await rm(item.path, {
      recursive: true,
      force: true
    });
    removed.push(item.label);
  }

  return removed;
}

export function readCleanupTarget(value: string | undefined): CleanupTarget | null {
  const normalizedValue = value?.trim().toLowerCase();
  return normalizedValue === "cache" || normalizedValue === "sessions" || normalizedValue === "temp" || normalizedValue === "all" ? normalizedValue : null;
}
