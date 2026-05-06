import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { inflateRawSync } from "node:zlib";
import type { AgentToolCall, ToolResult } from "./types.js";

const execFileAsync = promisify(execFile);

const ignoredDirectories = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  ".next",
  ".turbo",
  ".vite",
  "build",
  "out",
  "DerivedData"
]);

const textFileExtensions = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".css",
  ".h",
  ".hpp",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".mts",
  ".py",
  ".swift",
  ".ts",
  ".tsx",
  ".txt",
  ".java",
  ".kt",
  ".go",
  ".rs",
  ".php",
  ".rb",
  ".sh",
  ".bash",
  ".zsh",
  ".xml",
  ".toml",
  ".ini",
  ".csv",
  ".tsv",
  ".yml",
  ".yaml"
]);

const blockedPathNames = new Set([
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.test",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "id_rsa",
  "id_ed25519",
  "known_hosts"
]);

export type WorkspaceToolsOptions = {
  root: string;
  allowWrite: boolean;
  allowShell: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export class WorkspaceTools {
  readonly root: string;
  private readonly rootRealPath: Promise<string>;
  private readonly allowWrite: boolean;
  private readonly allowShell: boolean;
  private readonly timeoutMs: number;
  private readonly signal?: AbortSignal;

  constructor(options: WorkspaceToolsOptions) {
    this.root = path.resolve(options.root);
    this.rootRealPath = realpath(this.root).catch(() => this.root);
    this.allowWrite = options.allowWrite;
    this.allowShell = options.allowShell;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.signal = options.signal;
  }

  async execute(call: AgentToolCall): Promise<ToolResult> {
    try {
      switch (call.name) {
        case "list_files":
          return await this.listFiles(readString(call.arguments.path, "."));
        case "read_file":
          return await this.readFile(readString(call.arguments.path, ""));
        case "search_text":
          return await this.searchText(readString(call.arguments.query, ""));
        case "inspect_document":
          return await this.inspectDocument(readString(call.arguments.path, ""));
        case "write_file":
          return await this.writeFile(readString(call.arguments.path, ""), readString(call.arguments.content, ""));
        case "run_shell":
          return await this.runShell(readString(call.arguments.command, ""));
        default:
          return denied(`unknown tool: ${String((call as { name?: unknown }).name ?? "unknown")}`);
      }
    } catch (error) {
      return denied(error instanceof Error ? error.message : String(error));
    }
  }

  resolveInsideWorkspace(requestedPath: string): string {
    const workspaceRelativePath = this.normalizeWorkspaceRelativePath(requestedPath);
    const absolutePath = path.resolve(this.root, workspaceRelativePath);
    const relativePath = path.relative(this.root, absolutePath);

    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error(`Path escapes workspace: ${requestedPath}`);
    }

    return absolutePath;
  }

  normalizeWorkspaceRelativePath(requestedPath: string): string {
    const trimmedPath = requestedPath.trim();
    if (!trimmedPath || trimmedPath === ".") {
      return ".";
    }

    const normalizedRequestedPath = trimmedPath.replaceAll("\\", "/");
    const normalizedRoot = this.root.replaceAll("\\", "/");
    if (path.isAbsolute(trimmedPath)) {
      const relativePath = path.relative(this.root, trimmedPath);
      if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
        throw new Error(`Path escapes workspace: ${requestedPath}`);
      }

      return normalizeSlashPath(relativePath || ".");
    }

    const workspaceLabel = path.basename(this.root);
    if (
      workspaceLabel &&
      (normalizedRequestedPath === workspaceLabel || normalizedRequestedPath.startsWith(`${workspaceLabel}/`))
    ) {
      return normalizedRequestedPath.slice(workspaceLabel.length).replace(/^\/+/, "") || ".";
    }

    if (normalizedRequestedPath.startsWith(`${normalizedRoot}/`)) {
      return normalizedRequestedPath.slice(normalizedRoot.length).replace(/^\/+/, "") || ".";
    }

    return normalizedRequestedPath;
  }

  private async listFiles(requestedPath: string): Promise<ToolResult> {
    const rootPath = await this.resolveReadPath(requestedPath);
    const entries = await walkFiles(rootPath, this.root, await this.rootRealPath, 3, 160);
    return {
      ok: true,
      summary: `listed ${entries.length} files`,
      content: entries.join("\n")
    };
  }

  private async readFile(requestedPath: string): Promise<ToolResult> {
    if (!requestedPath) {
      return denied("read_file requires a path.");
    }

    if (isPlaceholderPath(requestedPath)) {
      return denied(`read_file denied placeholder path: ${requestedPath}`);
    }

    if (isSensitivePath(requestedPath)) {
      return denied(`read_file denied sensitive path: ${requestedPath}`);
    }

    const absolutePath = await this.resolveReadPath(requestedPath);
    if (!isLikelyTextFile(absolutePath)) {
      return denied(`read_file supports text/code files. Use inspect_document for ${path.extname(absolutePath) || "this file"} files.`);
    }

    const content = await readFile(absolutePath, "utf8").catch((error: unknown) => {
      throw new Error(`file not found or unreadable: ${requestedPath} (${error instanceof Error ? error.message : String(error)})`);
    });
    const clippedContent = clip(content, 20_000);
    return {
      ok: true,
      summary: `read ${path.relative(this.root, absolutePath)}`,
      content: clippedContent
    };
  }

  private async inspectDocument(requestedPath: string): Promise<ToolResult> {
    if (!requestedPath) {
      return denied("inspect_document requires a path.");
    }

    if (isPlaceholderPath(requestedPath)) {
      return denied(`inspect_document denied placeholder path: ${requestedPath}`);
    }

    if (isSensitivePath(requestedPath)) {
      return denied(`inspect_document denied sensitive path: ${requestedPath}`);
    }

    const absolutePath = await this.resolveReadPath(requestedPath);
    const extension = path.extname(absolutePath).toLowerCase();
    if (isLikelyTextFile(absolutePath)) {
      return await this.readFile(requestedPath);
    }

    if (extension === ".pdf") {
      return await extractPdfText(absolutePath, this.timeoutMs, this.signal);
    }

    if (extension === ".docx") {
      return await extractDocxText(absolutePath);
    }

    return denied(`inspect_document does not support ${extension || "this file type"} yet.`);
  }

  private async searchText(query: string): Promise<ToolResult> {
    if (!query.trim()) {
      return denied("search_text requires a non-empty query.");
    }

    const ripgrepResult = await searchTextWithRipgrep(this.root, query);
    if (ripgrepResult) {
      return ripgrepResult;
    }

    const rootRealPath = await this.rootRealPath;
    const files = await walkFiles(this.root, this.root, rootRealPath, 8, 800);
    const matches: string[] = [];

    for (const filePath of files) {
      const absolutePath = this.resolveInsideWorkspace(filePath);
      if (!isLikelyTextFile(absolutePath)) {
        continue;
      }

      const content = await readFile(absolutePath, "utf8").catch(() => "");
      const lines = content.split(/\r?\n/);
      lines.forEach((line, index) => {
        if (line.toLowerCase().includes(query.toLowerCase())) {
          matches.push(`${filePath}:${index + 1}: ${line.trim()}`);
        }
      });

      if (matches.length >= 80) {
        break;
      }
    }

    return {
      ok: true,
      summary: `found ${matches.length} matches`,
      content: matches.join("\n") || "No matches."
    };
  }

  private async writeFile(requestedPath: string, content: string): Promise<ToolResult> {
    if (!this.allowWrite) {
      return denied("write_file denied. Restart with --apply to allow workspace writes.");
    }

    if (!requestedPath) {
      return denied("write_file requires a path.");
    }

    if (isPlaceholderPath(requestedPath)) {
      return denied(`write_file denied placeholder path: ${requestedPath}`);
    }

    if (isSensitivePath(requestedPath)) {
      return denied(`write_file denied sensitive path: ${requestedPath}`);
    }

    const absolutePath = await this.resolveWritePath(requestedPath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");

    return {
      ok: true,
      summary: `wrote ${path.relative(this.root, absolutePath)}`,
      content: `Wrote ${content.length} characters.`
    };
  }

  private async runShell(command: string): Promise<ToolResult> {
    if (!this.allowShell) {
      return denied("run_shell denied. Restart with --allow-shell to allow commands.");
    }

    if (!command.trim()) {
      return denied("run_shell requires a command.");
    }

    const shellSafetyError = validateShellCommand(command);
    if (shellSafetyError) {
      return denied(`run_shell denied. ${shellSafetyError}`);
    }

    const output = await runCommand(command, this.root, this.timeoutMs, this.signal);
    return {
      ok: output.exitCode === 0,
      summary: `command exited ${output.exitCode}`,
      content: clip(output.output, 20_000)
    };
  }

  private async resolveReadPath(requestedPath: string): Promise<string> {
    const absolutePath = this.resolveInsideWorkspace(requestedPath);
    const resolvedPath = await realpath(absolutePath).catch((error: unknown) => {
      throw new Error(`file not found or unreadable: ${requestedPath} (${error instanceof Error ? error.message : String(error)})`);
    });
    await assertInsideWorkspace(await this.rootRealPath, resolvedPath, requestedPath);
    return resolvedPath;
  }

  private async resolveWritePath(requestedPath: string): Promise<string> {
    const absolutePath = this.resolveInsideWorkspace(requestedPath);
    const rootRealPath = await this.rootRealPath;
    const existingParent = await findNearestExistingParent(absolutePath);
    const parentRealPath = await realpath(existingParent);
    await assertInsideWorkspace(rootRealPath, parentRealPath, requestedPath);

    const targetStat = await lstat(absolutePath).catch(() => null);
    if (targetStat) {
      const resolvedTargetPath = await realpath(absolutePath).catch((error: unknown) => {
        throw new Error(`file not writable: ${requestedPath} (${error instanceof Error ? error.message : String(error)})`);
      });
      await assertInsideWorkspace(rootRealPath, resolvedTargetPath, requestedPath);
    }

    return absolutePath;
  }
}

async function walkFiles(
  startPath: string,
  workspaceRoot: string,
  workspaceRealRoot: string,
  maxDepth: number,
  maxEntries: number
): Promise<string[]> {
  const results: string[] = [];

  async function visit(currentPath: string, depth: number): Promise<void> {
    if (results.length >= maxEntries || depth > maxDepth) {
      return;
    }

    const currentStat = await lstat(currentPath);
    if (currentStat.isSymbolicLink()) {
      return;
    }

    if (currentStat.isFile()) {
      results.push(normalizeRelative(workspaceRoot, currentPath));
      return;
    }

    if (!currentStat.isDirectory()) {
      return;
    }

    await assertInsideWorkspace(workspaceRealRoot, await realpath(currentPath), normalizeRelative(workspaceRoot, currentPath));

    const entries = await readdir(currentPath, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (results.length >= maxEntries) {
        return;
      }

      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) {
        continue;
      }

      if (isSensitivePath(entry.name)) {
        continue;
      }

      await visit(path.join(currentPath, entry.name), depth + 1);
    }
  }

  await access(startPath, constants.R_OK);
  await visit(startPath, 0);
  return results;
}

async function searchTextWithRipgrep(workspaceRoot: string, query: string): Promise<ToolResult | null> {
  const ignoreGlobs = [
    "!.git/**",
    "!node_modules/**",
    "!dist/**",
    "!coverage/**",
    "!.next/**",
    "!.turbo/**",
      "!.vite/**",
      "!build/**",
      "!out/**",
      "!DerivedData/**",
      "!.env",
      "!.env.*",
      "!.npmrc",
      "!.pypirc",
      "!.netrc",
      "!**/.env",
      "!**/.env.*",
      "!**/.npmrc",
      "!**/.pypirc",
      "!**/.netrc",
      "!**/id_rsa",
      "!**/id_ed25519",
      "!**/known_hosts"
    ];

  return new Promise((resolve) => {
    const child = spawn(
      "rg",
      [
        "--line-number",
        "--ignore-case",
        "--no-heading",
        "--color",
        "never",
        "--max-count",
        "80",
        ...ignoreGlobs.flatMap((glob) => ["--glob", glob]),
        query,
        "."
      ],
      {
        cwd: workspaceRoot,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      }
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", () => {
      resolve(null);
    });

    child.on("close", (exitCode) => {
      if (exitCode === 0 || exitCode === 1) {
        const content = stdout.trim();
        const lines = content ? content.split(/\r?\n/).slice(0, 80) : [];
        resolve({
          ok: true,
          summary: `found ${lines.length} matches`,
          content: lines.join("\n") || "No matches."
        });
        return;
      }

      if (stderr.trim()) {
        resolve({
          ok: false,
          summary: "ripgrep search failed",
          content: clip(stderr.trim(), 1200)
        });
        return;
      }

      resolve(null);
    });
  });
}

async function assertInsideWorkspace(workspaceRealRoot: string, candidatePath: string, requestedPath: string): Promise<void> {
  const relativePath = path.relative(workspaceRealRoot, candidatePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Path escapes workspace: ${requestedPath}`);
  }
}

async function findNearestExistingParent(absolutePath: string): Promise<string> {
  let currentPath = path.dirname(absolutePath);
  while (true) {
    const currentStat = await stat(currentPath).catch(() => null);
    if (currentStat?.isDirectory()) {
      return currentPath;
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return currentPath;
    }

    currentPath = parentPath;
  }
}

function runCommand(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<{ exitCode: number | null; output: string }> {
  const isWindows = platform() === "win32";
  const shellExecutable = isWindows ? "powershell.exe" : "bash";
  const shellArgs = isWindows ? ["-NoProfile", "-Command", command] : ["-lc", command];

  return new Promise((resolve) => {
    const child = spawn(shellExecutable, shellArgs, {
      cwd,
      signal,
      windowsHide: true
    });

    let output = "";
    const timeout = setTimeout(() => {
      output += `\nCommand timed out after ${timeoutMs}ms.`;
      child.kill();
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      resolve({
        exitCode: error.name === "AbortError" ? null : 1,
        output: error.name === "AbortError" ? "Command aborted." : error.message
      });
    });

    child.on("close", (exitCode: number | null) => {
      clearTimeout(timeout);
      resolve({ exitCode, output });
    });
  });
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function isPlaceholderPath(value: string): boolean {
  const normalizedValue = value.trim().toLowerCase().replaceAll("\\", "/");
  return ["relative/path", "path/to/file", "file/path", "<path>", "<file>", "filename"].includes(normalizedValue);
}

function isSensitivePath(value: string): boolean {
  const normalizedPath = value.trim().replaceAll("\\", "/");
  return normalizedPath
    .split("/")
    .filter(Boolean)
    .some((part) => blockedPathNames.has(part.toLowerCase()));
}

function denied(message: string): ToolResult {
  return {
    ok: false,
    summary: message,
    content: message
  };
}

function isLikelyTextFile(filePath: string): boolean {
  return textFileExtensions.has(path.extname(filePath).toLowerCase());
}

async function extractPdfText(filePath: string, timeoutMs: number, signal?: AbortSignal): Promise<ToolResult> {
  try {
    const { stdout } = await execFileAsync("pdftotext", ["-layout", filePath, "-"], {
      timeout: timeoutMs,
      maxBuffer: 2_000_000,
      signal,
      windowsHide: true
    });
    return {
      ok: true,
      summary: `extracted text from ${path.basename(filePath)}`,
      content: clip(stdout.trim() || "No extractable PDF text found.", 20_000)
    };
  } catch (error) {
    return denied(`PDF text extraction needs pdftotext on PATH or a text-based PDF. ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function extractDocxText(filePath: string): Promise<ToolResult> {
  try {
    const archive = await readFile(filePath);
    const xml = readZipEntryText(archive, "word/document.xml");
    const text = wordXmlToText(xml);
    return {
      ok: true,
      summary: `extracted text from ${path.basename(filePath)}`,
      content: clip(text || "No extractable DOCX text found.", 20_000)
    };
  } catch (error) {
    return denied(`DOCX text extraction needs unzip on PATH and a valid .docx file. ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readZipEntryText(archive: Buffer, entryName: string): string {
  const endOfCentralDirectoryOffset = findEndOfCentralDirectory(archive);
  if (endOfCentralDirectoryOffset < 0) {
    throw new Error("invalid zip archive");
  }

  const centralDirectoryOffset = archive.readUInt32LE(endOfCentralDirectoryOffset + 16);
  const centralDirectoryEntries = archive.readUInt16LE(endOfCentralDirectoryOffset + 10);
  let offset = centralDirectoryOffset;

  for (let index = 0; index < centralDirectoryEntries; index += 1) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("invalid zip central directory");
    }

    const compressionMethod = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const fileNameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localHeaderOffset = archive.readUInt32LE(offset + 42);
    const fileName = archive.subarray(offset + 46, offset + 46 + fileNameLength).toString("utf8");

    if (fileName === entryName) {
      if (archive.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
        throw new Error("invalid zip local header");
      }

      const localFileNameLength = archive.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = archive.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localFileNameLength + localExtraLength;
      const compressedData = archive.subarray(dataStart, dataStart + compressedSize);
      if (compressionMethod === 0) {
        return compressedData.toString("utf8");
      }

      if (compressionMethod === 8) {
        return inflateRawSync(compressedData).toString("utf8");
      }

      throw new Error(`unsupported zip compression method ${compressionMethod}`);
    }

    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  throw new Error(`${entryName} not found`);
}

function findEndOfCentralDirectory(archive: Buffer): number {
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 65_557); offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }

  return -1;
}

function wordXmlToText(xml: string): string {
  return xml
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .trim();
}

function normalizeRelative(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function normalizeSlashPath(value: string): string {
  return value.split(path.sep).join("/");
}

function clip(content: string, maxLength: number): string {
  if (content.length <= maxLength) {
    return content;
  }

  return `${content.slice(0, maxLength)}\n...[clipped ${content.length - maxLength} chars]`;
}

function validateShellCommand(command: string): string | null {
  const trimmedCommand = command.trim();
  if (/[;&|><`$\n\r]/.test(trimmedCommand)) {
    return "shell metacharacters are blocked; run a single simple command.";
  }

  const tokens = trimmedCommand.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  if (tokens.length === 0) {
    return "command is empty.";
  }

  const executable = stripQuotes(tokens[0] ?? "").toLowerCase();
  if (["bash", "sh", "zsh", "fish", "pwsh", "powershell", "powershell.exe", "python", "python3", "node", "ruby", "perl"].includes(executable)) {
    return `executable "${executable}" is blocked.`;
  }

  for (const token of tokens.slice(1)) {
    const normalizedToken = stripQuotes(token);
    if (normalizedToken.startsWith("/") || normalizedToken.startsWith("~")) {
      return "absolute and home-relative paths are blocked.";
    }

    if (/(^|[\\/])\.\.([\\/]|$)/.test(normalizedToken)) {
      return "parent directory traversal is blocked.";
    }
  }

  return null;
}

function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, "");
}
