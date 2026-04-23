import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import path from "node:path";
import type { AgentToolCall, ToolResult } from "./types.js";

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
  ".yml",
  ".yaml"
]);

export type WorkspaceToolsOptions = {
  root: string;
  allowWrite: boolean;
  allowShell: boolean;
  timeoutMs?: number;
};

export class WorkspaceTools {
  readonly root: string;
  private readonly allowWrite: boolean;
  private readonly allowShell: boolean;
  private readonly timeoutMs: number;

  constructor(options: WorkspaceToolsOptions) {
    this.root = path.resolve(options.root);
    this.allowWrite = options.allowWrite;
    this.allowShell = options.allowShell;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async execute(call: AgentToolCall): Promise<ToolResult> {
    switch (call.name) {
      case "list_files":
        return this.listFiles(readString(call.arguments.path, "."));
      case "read_file":
        return this.readFile(readString(call.arguments.path, ""));
      case "search_text":
        return this.searchText(readString(call.arguments.query, ""));
      case "write_file":
        return this.writeFile(readString(call.arguments.path, ""), readString(call.arguments.content, ""));
      case "run_shell":
        return this.runShell(readString(call.arguments.command, ""));
      default:
        return denied(`unknown tool: ${String((call as { name?: unknown }).name ?? "unknown")}`);
    }
  }

  resolveInsideWorkspace(requestedPath: string): string {
    const absolutePath = path.resolve(this.root, requestedPath);
    const relativePath = path.relative(this.root, absolutePath);

    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error(`Path escapes workspace: ${requestedPath}`);
    }

    return absolutePath;
  }

  private async listFiles(requestedPath: string): Promise<ToolResult> {
    const rootPath = this.resolveInsideWorkspace(requestedPath);
    const entries = await walkFiles(rootPath, this.root, 3, 160);
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

    const absolutePath = this.resolveInsideWorkspace(requestedPath);
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

  private async searchText(query: string): Promise<ToolResult> {
    if (!query.trim()) {
      return denied("search_text requires a non-empty query.");
    }

    const files = await walkFiles(this.root, this.root, 8, 800);
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

    const absolutePath = this.resolveInsideWorkspace(requestedPath);
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

    const output = await runCommand(command, this.root, this.timeoutMs);
    return {
      ok: output.exitCode === 0,
      summary: `command exited ${output.exitCode}`,
      content: clip(output.output, 20_000)
    };
  }
}

async function walkFiles(startPath: string, workspaceRoot: string, maxDepth: number, maxEntries: number): Promise<string[]> {
  const results: string[] = [];

  async function visit(currentPath: string, depth: number): Promise<void> {
    if (results.length >= maxEntries || depth > maxDepth) {
      return;
    }

    const currentStat = await stat(currentPath);
    if (currentStat.isFile()) {
      results.push(normalizeRelative(workspaceRoot, currentPath));
      return;
    }

    const entries = await readdir(currentPath, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (results.length >= maxEntries) {
        return;
      }

      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) {
        continue;
      }

      await visit(path.join(currentPath, entry.name), depth + 1);
    }
  }

  await access(startPath, constants.R_OK);
  await visit(startPath, 0);
  return results;
}

function runCommand(command: string, cwd: string, timeoutMs: number): Promise<{ exitCode: number | null; output: string }> {
  const isWindows = platform() === "win32";
  const shellExecutable = isWindows ? "powershell.exe" : "bash";
  const shellArgs = isWindows ? ["-NoProfile", "-Command", command] : ["-lc", command];

  return new Promise((resolve) => {
    const child = spawn(shellExecutable, shellArgs, {
      cwd,
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

function normalizeRelative(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function clip(content: string, maxLength: number): string {
  if (content.length <= maxLength) {
    return content;
  }

  return `${content.slice(0, maxLength)}\n...[clipped ${content.length - maxLength} chars]`;
}
