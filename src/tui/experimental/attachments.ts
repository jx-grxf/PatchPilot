/**
 * Attachment / artifact model for the experimental shell. Attachments are
 * files the user drops into the prompt (a pasted path to an image / PDF /
 * DOCX …); artifacts also include files PatchPilot creates during a run.
 */
export type AttachmentKind = "image" | "pdf" | "docx" | "text" | "file";

export type Artifact = {
  id: number;
  kind: AttachmentKind;
  path: string;
  label: string;
  origin: "attached" | "created";
};

const extensionKinds: Record<string, AttachmentKind> = {
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".gif": "image",
  ".webp": "image",
  ".bmp": "image",
  ".heic": "image",
  ".pdf": "pdf",
  ".docx": "docx",
  ".doc": "docx",
  ".md": "text",
  ".txt": "text",
  ".rtf": "text",
};

/** Classify a path by extension; null if it is not an attachable document. */
export function attachmentKindForPath(path: string): AttachmentKind | null {
  const match = /\.[A-Za-z0-9]+$/.exec(path.trim());
  if (!match) {
    return null;
  }

  return extensionKinds[match[0].toLowerCase()] ?? null;
}

/** Remove a single layer of surrounding single/double quotes. */
export function stripQuotes(value: string): string {
  if (value.length >= 2 && ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'"))) {
    return value.slice(1, -1);
  }

  return value;
}

/**
 * Heuristic: does this pasted/typed value look like a single filesystem path
 * to an attachable document? Accepts absolute, home-relative, and quoted
 * paths; rejects free-form prose.
 */
export function looksLikeAttachmentPath(value: string): boolean {
  const trimmed = stripQuotes(value.trim());
  if (!trimmed || attachmentKindForPath(trimmed) === null) {
    return false;
  }

  const pathLike = trimmed.startsWith("/") || trimmed.startsWith("~") || trimmed.startsWith("./") || trimmed.includes("/");
  const wasQuoted = value.trim() !== trimmed;
  const hasInnerSpace = /\s/.test(trimmed);
  return pathLike && (wasQuoted || !hasInnerSpace);
}

const kindNames: Record<AttachmentKind, string> = {
  image: "Image",
  pdf: "PDF",
  docx: "DOCX",
  text: "Doc",
  file: "File",
};

/** Human label for an attachment chip, e.g. "Image #2". */
export function attachmentLabel(kind: AttachmentKind, index: number): string {
  return `${kindNames[kind]} #${index}`;
}

const kindSymbols: Record<AttachmentKind, string> = {
  image: "▣",
  pdf: "▤",
  docx: "▥",
  text: "▦",
  file: "▧",
};

export function attachmentSymbol(kind: AttachmentKind): string {
  return kindSymbols[kind];
}

// Control characters except tab (\t) and newline (\n) — built via escapes so
// no raw control bytes live in this source file.
const controlCharsPattern = new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]", "g");

/**
 * Normalise pasted text: drop carriage returns and stray control characters
 * (keeping tabs/newlines) so a multi-line paste does not corrupt the editor.
 */
export function sanitizePastedText(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(controlCharsPattern, "");
}
