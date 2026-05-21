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
  ".heic": "image",
  ".heif": "image",
  ".pdf": "pdf",
  ".docx": "docx",
  ".doc": "docx",
  ".svg": "text",
  ".md": "text",
  ".txt": "text",
  ".rtf": "text",
  ".json": "text",
  ".jsonl": "text",
  ".csv": "text",
  ".yaml": "text",
  ".yml": "text",
  ".toml": "text",
  ".xml": "text",
  ".html": "text",
  ".htm": "text",
  ".css": "text",
  ".scss": "text",
  ".js": "text",
  ".jsx": "text",
  ".ts": "text",
  ".tsx": "text",
  ".mjs": "text",
  ".mts": "text",
  ".cjs": "text",
  ".ini": "text",
  ".tsv": "text",
  ".py": "text",
  ".java": "text",
  ".kt": "text",
  ".go": "text",
  ".rs": "text",
  ".php": "text",
  ".rb": "text",
  ".swift": "text",
  ".c": "text",
  ".cc": "text",
  ".cpp": "text",
  ".h": "text",
  ".hpp": "text",
  ".sh": "text",
  ".zsh": "text",
  ".bash": "text",
  ".sql": "text",
  ".log": "text",
  ".diff": "text",
  ".patch": "text",
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

export function normalizeAttachmentPath(value: string): string {
  const trimmed = stripQuotes(value.trim()).replace(/\\([^\n])/g, "$1");
  if (trimmed.startsWith("file://")) {
    try {
      return decodeURIComponent(trimmed.replace(/^file:\/\//, ""));
    } catch {
      return trimmed.replace(/^file:\/\//, "");
    }
  }

  return trimmed;
}

function looksLikeAttachablePath(value: string, options: { allowSpaces: boolean }): boolean {
  const trimmed = normalizeAttachmentPath(value);
  if (!trimmed || attachmentKindForPath(trimmed) === null) {
    return false;
  }

  const pathLike = trimmed.startsWith("/") || trimmed.startsWith("~") || trimmed.startsWith("./") || trimmed.includes("/");
  const raw = value.trim();
  const wasQuoted = raw !== stripQuotes(raw);
  const hadEscapedSpace = /\\\s/.test(raw);
  const hasInnerSpace = /\s/.test(stripQuotes(raw));
  return pathLike && (options.allowSpaces || wasQuoted || hadEscapedSpace || !hasInnerSpace);
}

/**
 * Heuristic: does this pasted/typed value look like a single filesystem path
 * to an attachable document? Accepts absolute, home-relative, and quoted
 * paths; rejects free-form prose.
 */
export function looksLikeAttachmentPath(value: string): boolean {
  return looksLikeAttachablePath(value, { allowSpaces: false });
}

export function attachmentTypeForPath(path: string): string {
  const match = /\.[A-Za-z0-9]+$/.exec(normalizeAttachmentPath(path));
  if (!match) {
    return "FILE";
  }

  const extension = match[0].slice(1).toUpperCase();
  return extension === "JPEG" ? "JPG" : extension;
}

/** Human label for an attachment chip, e.g. "[PNG #2]". */
export function attachmentLabel(kind: AttachmentKind, index: number, path?: string): string {
  const type = path ? attachmentTypeForPath(path) : kind.toUpperCase();
  return `[${type} #${index}]`;
}

export function extractAttachmentPaths(value: string): string[] | null {
  const sanitized = sanitizePastedText(value);
  const lines = sanitized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length > 1 && lines.every((line) => looksLikeAttachablePath(line, { allowSpaces: true }))) {
    return lines.map(normalizeAttachmentPath);
  }

  const tokens = splitShellLikePaths(sanitized);
  if (tokens.length > 0 && tokens.every((token) => looksLikeAttachablePath(token, { allowSpaces: false }))) {
    return tokens.map(normalizeAttachmentPath);
  }

  return null;
}

function splitShellLikePaths(value: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaping = false;

  for (const char of value.trim()) {
    if (escaping) {
      current += `\\${char}`;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if ((char === "\"" || char === "'") && !quote) {
      quote = char;
      current += char;
      continue;
    }

    if (quote === char) {
      quote = null;
      current += char;
      continue;
    }

    if (!quote && /\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaping) {
    current += "\\";
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
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

export function formatSessionArtifactContext(artifacts: Artifact[], limit = 12): string {
  const visibleArtifacts = artifacts.slice(-limit);
  if (visibleArtifacts.length === 0) {
    return "";
  }

  return [
    "Known session attachments and artifacts (most recent last).",
    "If the user asks about a prior uploaded file or artifact, use these paths and inspect the document before answering; provider chat state may not retain file inputs across PatchPilot runs.",
    ...visibleArtifacts.map((artifact) => {
      const type = attachmentTypeForPath(artifact.path);
      return `- ${artifact.label} origin=${artifact.origin} type=${type} path=${JSON.stringify(artifact.path)}`;
    })
  ].join("\n");
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
