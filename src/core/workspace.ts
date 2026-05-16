import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { inflateRawSync } from "node:zlib";
import type { AgentToolCall, AgentToolName, ApprovalRequest, PermissionDecision, ToolCategory, ToolPermission, ToolResult, ToolRisk, ToolSpec } from "./types.js";

const execFileAsync = promisify(execFile);

const ignoredDirectories = new Set([
  ".git",
  ".patchpilot",
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
  approvalHandler?: (request: ApprovalRequest) => Promise<PermissionDecision>;
};

export const toolSpecs: Record<AgentToolName, ToolSpec> = {
  list_files: {
    name: "list_files",
    description: "List workspace files under a directory.",
    risk: "low",
    sideEffects: "none",
    permission: "none",
    category: "read"
  },
  read_file: {
    name: "read_file",
    description: "Read a complete text/code file.",
    risk: "low",
    sideEffects: "none",
    permission: "none",
    category: "read"
  },
  read_range: {
    name: "read_range",
    description: "Read a bounded 1-based line range from a text/code file.",
    risk: "low",
    sideEffects: "none",
    permission: "none",
    category: "read"
  },
  file_info: {
    name: "file_info",
    description: "Inspect file metadata inside the workspace.",
    risk: "low",
    sideEffects: "none",
    permission: "none",
    category: "read"
  },
  search_text: {
    name: "search_text",
    description: "Search workspace text with ripgrep.",
    risk: "low",
    sideEffects: "none",
    permission: "none",
    category: "search"
  },
  inspect_document: {
    name: "inspect_document",
    description: "Extract text from supported documents.",
    risk: "low",
    sideEffects: "none",
    permission: "none",
    category: "document"
  },
  git_status: {
    name: "git_status",
    description: "Read the current Git branch and dirty state.",
    risk: "low",
    sideEffects: "none",
    permission: "none",
    category: "git"
  },
  git_diff: {
    name: "git_diff",
    description: "Read the current Git diff.",
    risk: "low",
    sideEffects: "none",
    permission: "none",
    category: "git"
  },
  list_changed_files: {
    name: "list_changed_files",
    description: "List changed files from Git porcelain status.",
    risk: "low",
    sideEffects: "none",
    permission: "none",
    category: "git"
  },
  list_scripts: {
    name: "list_scripts",
    description: "List package.json scripts.",
    risk: "low",
    sideEffects: "none",
    permission: "none",
    category: "read"
  },
  write_file: {
    name: "write_file",
    description: "Write a full file in the workspace.",
    risk: "high",
    sideEffects: "write",
    permission: "write",
    category: "write"
  },
  apply_patch: {
    name: "apply_patch",
    description: "Apply a unified Git patch inside the workspace.",
    risk: "high",
    sideEffects: "write",
    permission: "write",
    category: "write"
  },
  run_script: {
    name: "run_script",
    description: "Run a named package.json script.",
    risk: "medium",
    sideEffects: "shell",
    permission: "shell",
    category: "shell"
  },
  run_tests: {
    name: "run_tests",
    description: "Run the repository test script.",
    risk: "medium",
    sideEffects: "shell",
    permission: "shell",
    category: "test"
  },
  run_shell: {
    name: "run_shell",
    description: "Run a restricted one-line shell command.",
    risk: "high",
    sideEffects: "shell",
    permission: "shell",
    category: "shell"
  }
};

export function getToolSpec(name: AgentToolName): ToolSpec {
  return toolSpecs[name];
}

export class WorkspaceTools {
  readonly root: string;
  private readonly rootRealPath: Promise<string>;
  private readonly allowWrite: boolean;
  private readonly allowShell: boolean;
  private readonly timeoutMs: number;
  private readonly signal?: AbortSignal;
  private readonly approvalHandler?: (request: ApprovalRequest) => Promise<PermissionDecision>;
  private readonly sessionApprovals = new Set<ToolPermission>();

  constructor(options: WorkspaceToolsOptions) {
    this.root = path.resolve(options.root);
    this.rootRealPath = realpath(this.root).catch(() => this.root);
    this.allowWrite = options.allowWrite;
    this.allowShell = options.allowShell;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.signal = options.signal;
    this.approvalHandler = options.approvalHandler;
  }

  async execute(call: AgentToolCall): Promise<ToolResult> {
    try {
      switch (call.name) {
        case "list_files":
          return await this.listFiles(readString(call.arguments.path, "."));
        case "read_file":
          return await this.readFile(readString(call.arguments.path, ""));
        case "read_range":
          return await this.readRange(
            readString(call.arguments.path, ""),
            readNumber(call.arguments.start, 1),
            readNumber(call.arguments.end, readNumber(call.arguments.start, 1) + 80)
          );
        case "file_info":
          return await this.fileInfo(readString(call.arguments.path, ""));
        case "search_text":
          return await this.searchText(readString(call.arguments.query, ""));
        case "inspect_document":
          return await this.inspectDocument(readString(call.arguments.path, ""));
        case "git_status":
          return await this.gitStatus();
        case "git_diff":
          return await this.gitDiff(readString(call.arguments.path, ""));
        case "list_changed_files":
          return await this.listChangedFiles();
        case "list_scripts":
          return await this.listScripts();
        case "write_file":
          return await this.writeFile(readString(call.arguments.path, ""), readString(call.arguments.content, ""));
        case "apply_patch":
          return await this.applyPatch(readString(call.arguments.patch, ""));
        case "run_script":
          return await this.runScript(readString(call.arguments.script, ""));
        case "run_tests":
          return await this.runTests();
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
      content: entries.join("\n"),
      tool: "list_files",
      category: toolSpecs.list_files.category
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
      content: clippedContent,
      tool: "read_file",
      category: toolSpecs.read_file.category
    };
  }

  private async readRange(requestedPath: string, startLine: number, endLine: number): Promise<ToolResult> {
    if (!requestedPath) {
      return denied("read_range requires a path.", "read_range");
    }

    if (startLine < 1 || endLine < startLine) {
      return denied("read_range requires 1-based start/end lines.", "read_range");
    }

    if (isPlaceholderPath(requestedPath)) {
      return denied(`read_range denied placeholder path: ${requestedPath}`, "read_range");
    }

    if (isSensitivePath(requestedPath)) {
      return denied(`read_range denied sensitive path: ${requestedPath}`, "read_range");
    }

    const absolutePath = await this.resolveReadPath(requestedPath);
    if (!isLikelyTextFile(absolutePath)) {
      return denied(`read_range supports text/code files. Use inspect_document for ${path.extname(absolutePath) || "this file"} files.`, "read_range");
    }

    const lines = (await readFile(absolutePath, "utf8")).split(/\r?\n/);
    const selectedLines = lines.slice(startLine - 1, endLine);
    const numberedLines = selectedLines.map((line, index) => `${startLine + index}: ${line}`).join("\n");
    return {
      ok: true,
      summary: `read ${path.relative(this.root, absolutePath)}:${startLine}-${Math.min(endLine, lines.length)}`,
      content: clip(numberedLines || "No lines in range.", 20_000),
      tool: "read_range",
      category: toolSpecs.read_range.category,
      metadata: {
        path: path.relative(this.root, absolutePath),
        startLine,
        endLine: Math.min(endLine, lines.length)
      }
    };
  }

  private async fileInfo(requestedPath: string): Promise<ToolResult> {
    if (!requestedPath) {
      return denied("file_info requires a path.", "file_info");
    }

    if (isSensitivePath(requestedPath)) {
      return denied(`file_info denied sensitive path: ${requestedPath}`, "file_info");
    }

    const absolutePath = await this.resolveReadPath(requestedPath);
    const fileStat = await stat(absolutePath);
    const relativePath = path.relative(this.root, absolutePath);
    return {
      ok: true,
      summary: `inspected ${relativePath}`,
      content: [
        `path: ${relativePath}`,
        `type: ${fileStat.isDirectory() ? "directory" : fileStat.isFile() ? "file" : "other"}`,
        `size: ${fileStat.size} bytes`,
        `modified: ${fileStat.mtime.toISOString()}`
      ].join("\n"),
      tool: "file_info",
      category: toolSpecs.file_info.category,
      metadata: {
        path: relativePath,
        size: fileStat.size,
        modifiedAt: fileStat.mtime.toISOString()
      }
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

    const ripgrepResult = await searchTextWithRipgrep(this.root, query, this.timeoutMs, this.signal);
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
      content: matches.join("\n") || "No matches.",
      tool: "search_text",
      category: toolSpecs.search_text.category
    };
  }

  private async writeFile(requestedPath: string, content: string): Promise<ToolResult> {
    if (!requestedPath) {
      return denied("write_file requires a path.");
    }

    if (isPlaceholderPath(requestedPath)) {
      return denied(`write_file denied placeholder path: ${requestedPath}`);
    }

    if (isSensitivePath(requestedPath)) {
      return denied(`write_file denied sensitive path: ${requestedPath}`);
    }

    if (!this.allowWrite) {
      const approval = await this.requestApproval("write_file", "write", {
        path: requestedPath,
        contentLength: content.length
      }, `Write ${requestedPath} (${content.length} characters).`);
      if (approval.decision === "deny") {
        return denied("write_file denied by permission policy. Restart with --apply or approve the request in build mode.", "write_file", approval);
      }
    }

    const absolutePath = await this.resolveWritePath(requestedPath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");

    return {
      ok: true,
      summary: `wrote ${path.relative(this.root, absolutePath)}`,
      content: `Wrote ${content.length} characters.`,
      tool: "write_file",
      category: toolSpecs.write_file.category,
      preview: `Write ${path.relative(this.root, absolutePath)}`
    };
  }

  private async gitStatus(): Promise<ToolResult> {
    const { stdout } = await execFileAsync("git", ["status", "--short", "--branch"], {
      cwd: this.root,
      timeout: Math.min(this.timeoutMs, 8000),
      maxBuffer: 200_000,
      signal: this.signal,
      windowsHide: true
    });

    return {
      ok: true,
      summary: "read git status",
      content: stdout.trim() || "No git status output.",
      tool: "git_status",
      category: toolSpecs.git_status.category
    };
  }

  private async gitDiff(requestedPath: string): Promise<ToolResult> {
    const args = ["diff", "--"];
    if (requestedPath.trim()) {
      const absolutePath = this.resolveInsideWorkspace(requestedPath);
      args.push(path.relative(this.root, absolutePath));
    }

    const { stdout } = await execFileAsync("git", args, {
      cwd: this.root,
      timeout: Math.min(this.timeoutMs, 8000),
      maxBuffer: 1_000_000,
      signal: this.signal,
      windowsHide: true
    });

    return {
      ok: true,
      summary: stdout.trim() ? "read git diff" : "no git diff",
      content: clip(stdout.trim() || "No changes.", 20_000),
      tool: "git_diff",
      category: toolSpecs.git_diff.category
    };
  }

  private async listChangedFiles(): Promise<ToolResult> {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
      cwd: this.root,
      timeout: Math.min(this.timeoutMs, 8000),
      maxBuffer: 200_000,
      signal: this.signal,
      windowsHide: true
    });

    const files = stdout
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean);

    return {
      ok: true,
      summary: `listed ${files.length} changed file${files.length === 1 ? "" : "s"}`,
      content: files.join("\n") || "No changed files.",
      tool: "list_changed_files",
      category: toolSpecs.list_changed_files.category
    };
  }

  private async listScripts(): Promise<ToolResult> {
    const packageJsonPath = await this.resolveReadPath("package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as { scripts?: Record<string, unknown> };
    const scripts = Object.entries(packageJson.scripts ?? {})
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .sort(([left], [right]) => left.localeCompare(right));

    return {
      ok: true,
      summary: `listed ${scripts.length} package scripts`,
      content: scripts.map(([name, command]) => `${name}: ${command}`).join("\n") || "No package scripts found.",
      tool: "list_scripts",
      category: toolSpecs.list_scripts.category
    };
  }

  private async applyPatch(patchContent: string): Promise<ToolResult> {
    if (!patchContent.trim()) {
      return denied("apply_patch requires a unified patch.", "apply_patch");
    }

    if (!this.allowWrite) {
      const approval = await this.requestApproval(
        "apply_patch",
        "write",
        {
          patch: clip(patchContent, 1200)
        },
        previewPatch(patchContent)
      );
      if (approval.decision === "deny") {
        return denied("apply_patch denied by permission policy.", "apply_patch", approval);
      }
    }

    const output = await runGitApply(patchContent, this.root, this.timeoutMs, this.signal);
    return {
      ok: output.exitCode === 0,
      summary: output.exitCode === 0 ? "applied patch" : `git apply exited ${output.exitCode}`,
      content: clip(output.output || (output.exitCode === 0 ? "Patch applied." : "Patch failed."), 20_000),
      tool: "apply_patch",
      category: toolSpecs.apply_patch.category,
      preview: previewPatch(patchContent)
    };
  }

  private async runScript(scriptName: string): Promise<ToolResult> {
    const normalizedScript = scriptName.trim();
    if (!/^[\w:.-]+$/.test(normalizedScript)) {
      return denied("run_script requires a package script name such as test or build.", "run_script");
    }

    const scripts = await this.readPackageScripts();
    if (!scripts[normalizedScript]) {
      return denied(`package script not found: ${normalizedScript}`, "run_script");
    }

    if (!this.allowShell) {
      const approval = await this.requestApproval(
        "run_script",
        "shell",
        {
          script: normalizedScript
        },
        `Run package script: npm run ${normalizedScript}`
      );
      if (approval.decision === "deny") {
        return denied("run_script denied by permission policy.", "run_script", approval);
      }
    }

    const output = await runCommand(`npm run ${normalizedScript}`, this.root, this.timeoutMs, this.signal);
    return {
      ok: output.exitCode === 0,
      summary: `npm run ${normalizedScript} exited ${output.exitCode}`,
      content: clip(output.output, 20_000),
      tool: "run_script",
      category: toolSpecs.run_script.category,
      preview: `npm run ${normalizedScript}`
    };
  }

  private async runTests(): Promise<ToolResult> {
    const scripts = await this.readPackageScripts();
    if (!scripts.test) {
      return denied("No package test script found.", "run_tests");
    }

    const result = await this.runScript("test");
    return {
      ...result,
      tool: "run_tests",
      category: toolSpecs.run_tests.category,
      preview: "npm test"
    };
  }

  private async runShell(command: string): Promise<ToolResult> {
    if (!command.trim()) {
      return denied("run_shell requires a command.");
    }

    const shellSafetyError = validateShellCommand(command);
    if (shellSafetyError) {
      return denied(`run_shell denied. ${shellSafetyError}`);
    }

    if (!this.allowShell) {
      const approval = await this.requestApproval(
        "run_shell",
        "shell",
        {
          command
        },
        `Run shell command: ${command}`
      );
      if (approval.decision === "deny") {
        return denied("run_shell denied by permission policy.", "run_shell", approval);
      }
    }

    const output = await runCommand(command, this.root, this.timeoutMs, this.signal);
    return {
      ok: output.exitCode === 0,
      summary: `command exited ${output.exitCode}`,
      content: clip(output.output, 20_000),
      tool: "run_shell",
      category: toolSpecs.run_shell.category,
      preview: command
    };
  }

  private async readPackageScripts(): Promise<Record<string, string>> {
    const packageJsonPath = await this.resolveReadPath("package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as { scripts?: Record<string, unknown> };
    return Object.fromEntries(Object.entries(packageJson.scripts ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  }

  private async requestApproval(
    tool: AgentToolName,
    permission: Exclude<ToolPermission, "none">,
    args: Record<string, unknown>,
    preview: string
  ): Promise<{ request: ApprovalRequest; decision: PermissionDecision }> {
    const spec = getToolSpec(tool);
    const request: ApprovalRequest = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      tool,
      permission,
      risk: spec.risk,
      preview,
      arguments: args
    };

    if (this.sessionApprovals.has(permission)) {
      return {
        request,
        decision: "allow_session"
      };
    }

    if (!this.approvalHandler) {
      return {
        request,
        decision: "deny"
      };
    }

    const decision = await this.approvalHandler(request);
    if (decision === "allow_session") {
      this.sessionApprovals.add(permission);
    }

    return {
      request,
      decision
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

async function searchTextWithRipgrep(workspaceRoot: string, query: string, timeoutMs: number, signal?: AbortSignal): Promise<ToolResult | null> {
  const ignoreGlobs = [
    "!.git/**",
    "!.patchpilot/**",
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
        signal,
        windowsHide: true
      }
    );

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      resolve({
        ok: false,
        summary: "ripgrep search timed out",
        content: `Search timed out after ${timeoutMs}ms. Narrow the query or path.`
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      resolve(error.name === "AbortError" ? denied("ripgrep search aborted.") : null);
    });

    child.on("close", (exitCode) => {
      clearTimeout(timeout);
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

function runGitApply(patchContent: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", ["apply", "--whitespace=nowarn", "-"], {
      cwd,
      signal,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let output = "";
    const timeout = setTimeout(() => {
      output += `\nPatch timed out after ${timeoutMs}ms.`;
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
        output: error.name === "AbortError" ? "Patch aborted." : error.message
      });
    });

    child.on("close", (exitCode: number | null) => {
      clearTimeout(timeout);
      resolve({ exitCode, output });
    });

    child.stdin.end(patchContent);
  });
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function readNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return fallback;
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

function denied(
  message: string,
  tool?: AgentToolName,
  approval?: {
    request: ApprovalRequest;
    decision: PermissionDecision;
  }
): ToolResult {
  return {
    ok: false,
    summary: message,
    content: message,
    tool,
    category: tool ? toolSpecs[tool].category : undefined,
    approval
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

function previewPatch(patchContent: string): string {
  const changedFiles = patchContent
    .split(/\r?\n/)
    .filter((line) => line.startsWith("+++ ") || line.startsWith("--- "))
    .map((line) => line.slice(4).replace(/^a\//, "").replace(/^b\//, ""))
    .filter((file) => file !== "/dev/null");
  const uniqueFiles = [...new Set(changedFiles)].slice(0, 6);
  const fileSummary = uniqueFiles.length > 0 ? uniqueFiles.join(", ") : "unknown files";
  const added = patchContent.split(/\r?\n/).filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
  const removed = patchContent.split(/\r?\n/).filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
  return `Apply patch to ${fileSummary} (+${added}/-${removed}).`;
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
  const subcommand = stripQuotes(tokens[1] ?? "").toLowerCase();
  if (["bash", "sh", "zsh", "fish", "pwsh", "powershell", "powershell.exe", "python", "python3", "node", "ruby", "perl"].includes(executable)) {
    return `executable "${executable}" is blocked.`;
  }

  if (["rm", "rmdir", "mv", "cp"].includes(executable) && tokens.some((token) => /^-.*[fRr]/.test(stripQuotes(token)))) {
    return `destructive ${executable} flags are blocked.`;
  }

  if (executable === "git" && ["clean", "reset", "push", "checkout", "switch", "branch", "tag"].includes(subcommand)) {
    return `git ${subcommand} is blocked in the shell tool.`;
  }

  if (executable === "npm" && ["publish", "unpublish", "dist-tag"].includes(subcommand)) {
    return `npm ${subcommand} is blocked in the shell tool.`;
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
