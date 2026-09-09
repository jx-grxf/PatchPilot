import { statSync } from "node:fs";
import path from "node:path";
import type { ModelProvider } from "../core/types.js";
import { attachmentKindForPath, attachmentLabel, attachmentTypeForPath } from "./experimental/attachments.js";

/**
 * Limits and labels for files attached to a prompt.
 *
 * A local model is bounded by its context window and by VRAM rather than by an
 * upload rule, so these thresholds are about what a run can actually hold.
 */

export const bytesPerMiB = 1024 * 1024;
/**
 * Local models are bounded by context window and VRAM rather than by an API's
 * upload rules, so these thresholds are about what a local run can actually
 * hold, not what a service will accept.
 */
export const promptFileLimit = 8;
export const largeFileBytes = 32 * bytesPerMiB;
export const largePdfBytes = 8 * bytesPerMiB;
export const totalPromptWarnBytes = 16 * bytesPerMiB;

export function attachmentLimitWarning(paths: string[], provider: ModelProvider): string | null {
  if (paths.length === 0) {
    return null;
  }

  const files = paths.map((filePath) => ({
    path: filePath,
    type: attachmentTypeForPath(filePath),
    size: readFileSize(filePath)
  }));
  const knownTotalBytes = files.reduce((total, file) => total + (typeof file.size === "number" ? file.size : 0), 0);
  const largePdf = files.find((file) => file.type === "PDF" && typeof file.size === "number" && file.size > largePdfBytes);
  const largeFile = files.find((file) => typeof file.size === "number" && file.size > largeFileBytes);

  if (paths.length > promptFileLimit) {
    return `Attached ${paths.length} files. A local model holds far less context than a hosted one \u2014 split this into batches of ${promptFileLimit} or fewer.`;
  }

  if (largeFile) {
    return `${attachmentTypeForPath(largeFile.path)} file ${attachmentBasename(largeFile.path)} is over ${formatMiB(largeFileBytes)}; it will very likely overflow the model's context window.`;
  }

  if (largePdf) {
    return `${attachmentTypeForPath(largePdf.path)} file ${attachmentBasename(largePdf.path)} is over ${formatMiB(largePdfBytes)}; extraction may be slow and incomplete on local hardware.`;
  }

  if (knownTotalBytes > totalPromptWarnBytes) {
    return `Attached files total about ${formatMiB(knownTotalBytes)}; run /doctor to check the loaded context window before sending.`;
  }

  return null;
}

export function readFileSize(filePath: string): number | null {
  try {
    const stats = statSync(filePath);
    return stats.isFile() ? stats.size : null;
  } catch {
    return null;
  }
}

export function formatMiB(bytes: number): string {
  return `${Math.round((bytes / bytesPerMiB) * 10) / 10} MiB`;
}

export function formatAttachedDocuments(paths: string[]): string {
  const counts = new Map<string, number>();
  return paths
    .map((filePath) => {
      const kind = attachmentKindForPath(filePath) ?? "file";
      const type = attachmentTypeForPath(filePath);
      const index = (counts.get(type) ?? 0) + 1;
      counts.set(type, index);
      return `- ${attachmentLabel(kind, index, filePath)} path=${JSON.stringify(filePath)}`;
    })
    .join("\n");
}

/** Last path segment, splitting on both POSIX and Windows separators. */
export function attachmentBasename(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).at(-1) ?? filePath;
}

export function formatAttachmentDigestPath(filePath: string): string {
  return JSON.stringify(filePath.split(/[\\/]/).filter(Boolean).at(-1) ?? filePath);
}
