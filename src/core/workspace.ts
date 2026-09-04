import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { constants, realpathSync } from "node:fs";
import { access, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { homedir, platform, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { fetchWithTimeout } from "./http.js";
import { MemoryStore } from "./memory.js";
import type { AgentToolCall, AgentToolName, ApprovalRequest, PermissionDecision, ToolCategory, ToolPermission, ToolResult, ToolRisk, ToolSpec } from "./types.js";

const execFileAsync = promisify(execFile);
type DocumentAnalyzer = (request: { path: string; prompt: string; signal?: AbortSignal }) => Promise<string>;

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
  ".svg",
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
  ".jsonl",
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
  ".envrc",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "credentials.json",
  "secrets.json",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
  "known_hosts"
]);

const blockedPathPatterns = [
  /(^|\/)(cookies|network\/cookies|login data|web data)$/i,
  /(^|\/)(chrome|chromium|brave-browser|brave|microsoft edge|edge|arc|firefox|safari)(\/|$)/i,
  /(^|\/)(default|profile \d+|profiles?)\/(cookies|network\/cookies|login data|web data)$/i
];

export type WorkspaceToolsOptions = {
  root: string;
  allowWrite: boolean;
  allowShell: boolean;
  allowShellMetacharacters?: boolean;
  allowExternalFileAnalysis?: boolean;
  documentAnalyzer?: DocumentAnalyzer;
  memoryEnabled?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  approvalHandler?: (request: ApprovalRequest) => Promise<PermissionDecision>;
};

export const toolSpecs: Record<AgentToolName, ToolSpec> = {
  update_todo: {
    name: "update_todo",
    description: "Update the agent's visible task checklist.",
    risk: "low",
    sideEffects: "none",
    permission: "none",
    category: "state"
  },
  list_files: {
    name: "list_files",
    description: "List workspace files under a directory.",
    risk: "low",
    sideEffects: "none",
    permission: "none",
    category: "read"
  },
  find_files: {
    name: "find_files",
    description: "Find workspace files by path/name substring.",
    risk: "low",
    sideEffects: "none",
    permission: "none",
    category: "search"
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
  fetch_url: {
    name: "fetch_url",
    description: "Fetch a public http(s) URL and return its text content. Keyless web access available to every model; private/loopback hosts are blocked.",
    risk: "medium",
    sideEffects: "none",
    permission: "network",
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
  memory_remember: {
    name: "memory_remember",
    description: "Store a durable memory for this workspace.",
    risk: "low",
    sideEffects: "write",
    permission: "write",
    category: "memory"
  },
  memory_search: {
    name: "memory_search",
    description: "Search durable workspace memories.",
    risk: "low",
    sideEffects: "none",
    permission: "none",
    category: "memory"
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
  git_log: {
    name: "git_log",
    description: "Read recent Git commits.",
    risk: "low",
    sideEffects: "none",
    permission: "none",
    category: "git"
  },
  git_show: {
    name: "git_show",
    description: "Read a compact Git commit or revision summary.",
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
  repo_overview: {
    name: "repo_overview",
    description: "Read a compact repository overview: package metadata, top-level files, and Git state.",
    risk: "low",
    sideEffects: "none",
    permission: "none",
    category: "read"
  },
  test_list: {
    name: "test_list",
    description: "List likely tests and test scripts without running them.",
    risk: "low",
    sideEffects: "none",
    permission: "none",
    category: "test"
  },
  dependency_tree: {
    name: "dependency_tree",
    description: "Read top-level package dependencies from package.json.",
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
  edit_file: {
    name: "edit_file",
    description: "Edit an existing text file by unique find/replace or by replacing a bounded line range with an optional expected-content guard.",
    risk: "high",
    sideEffects: "write",
    permission: "write",
    category: "write"
  },
  create_pdf: {
    name: "create_pdf",
    description: "Create a simple text PDF file in the workspace.",
    risk: "high",
    sideEffects: "write",
    permission: "write",
    category: "write"
  },
  create_docx: {
    name: "create_docx",
    description: "Create a simple text DOCX file in the workspace.",
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
  private readonly allowShellMetacharacters: boolean;
  private readonly allowExternalFileAnalysis: boolean;
  private readonly memoryEnabled: boolean;
  private readonly documentAnalyzer?: DocumentAnalyzer;
  private readonly timeoutMs: number;
  private readonly signal?: AbortSignal;
  private readonly approvalHandler?: (request: ApprovalRequest) => Promise<PermissionDecision>;
  private readonly sessionApprovals = new Set<string>();

  constructor(options: WorkspaceToolsOptions) {
    this.root = path.resolve(options.root);
    this.rootRealPath = realpath(this.root).catch(() => this.root);
    this.allowWrite = options.allowWrite;
    this.allowShell = options.allowShell;
    this.allowShellMetacharacters = Boolean(options.allowShellMetacharacters);
    this.allowExternalFileAnalysis = Boolean(options.allowExternalFileAnalysis);
    this.documentAnalyzer = options.documentAnalyzer;
    this.memoryEnabled = Boolean(options.memoryEnabled);
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.signal = options.signal;
    this.approvalHandler = options.approvalHandler;
  }

  async execute(call: AgentToolCall): Promise<ToolResult> {
    try {
      switch (call.name) {
        case "update_todo":
          return this.updateTodo(call.arguments);
        case "list_files":
          return await this.listFiles(readString(call.arguments.path, "."));
        case "find_files":
          return await this.findFiles(readString(call.arguments.query, ""), readNumber(call.arguments.limit, 80));
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
        case "fetch_url":
          return await this.fetchUrl(readString(call.arguments.url, ""), readNumber(call.arguments.max_chars, 0));
        case "inspect_document":
          return await this.inspectDocument(readString(call.arguments.path, ""), readString(call.arguments.mode, "auto"));
        case "memory_remember":
          return await this.memoryRemember(readString(call.arguments.content, ""), readStringArray(call.arguments.tags));
        case "memory_search":
          return await this.memorySearch(readString(call.arguments.query, ""), readNumber(call.arguments.limit, 8));
        case "git_status":
          return await this.gitStatus();
        case "git_diff":
          return await this.gitDiff(readString(call.arguments.path, ""));
        case "git_log":
          return await this.gitLog(readNumber(call.arguments.limit, 8));
        case "git_show":
          return await this.gitShow(readString(call.arguments.revision, "HEAD"), readString(call.arguments.path, ""));
        case "list_changed_files":
          return await this.listChangedFiles();
        case "list_scripts":
          return await this.listScripts();
        case "repo_overview":
          return await this.repoOverview();
        case "test_list":
          return await this.testList();
        case "dependency_tree":
          return await this.dependencyTree();
        case "write_file":
          return await this.writeFile(readString(call.arguments.path, ""), readString(call.arguments.content, ""));
        case "edit_file":
          return await this.editFile(
            readString(call.arguments.path, ""),
            readString(call.arguments.find, ""),
            readString(call.arguments.replace, ""),
            readNumber(call.arguments.startLine, 0),
            readNumber(call.arguments.endLine, 0),
            readString(call.arguments.replacement, ""),
            readOptionalString(call.arguments.expected)
          );
        case "create_pdf":
          return await this.createPdf(readString(call.arguments.path, ""), readString(call.arguments.content, ""), readString(call.arguments.title, ""));
        case "create_docx":
          return await this.createDocx(readString(call.arguments.path, ""), readString(call.arguments.content, ""), readString(call.arguments.title, ""));
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

  private updateTodo(argumentsValue: Record<string, unknown>): ToolResult {
    return {
      ok: true,
      summary: "updated visible todo list",
      content: JSON.stringify({ items: Array.isArray(argumentsValue.items) ? argumentsValue.items : [] }),
      tool: "update_todo",
      category: toolSpecs.update_todo.category,
      metadata: {
        items: Array.isArray(argumentsValue.items) ? argumentsValue.items : []
      }
    };
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

  private async findFiles(query: string, limit: number): Promise<ToolResult> {
    const normalizedQuery = query.trim().replaceAll("\\", "/").toLowerCase();
    if (!normalizedQuery) {
      return denied("find_files requires a non-empty query.", "find_files");
    }

    if (isPlaceholderPath(normalizedQuery)) {
      return denied(`find_files denied placeholder query: ${query}`, "find_files");
    }

    if (isSensitivePath(normalizedQuery)) {
      return denied(`find_files denied sensitive query: ${query}`, "find_files");
    }

    const normalizedLimit = Math.max(1, Math.min(200, Math.floor(limit || 80)));
    const files = await walkFiles(this.root, this.root, await this.rootRealPath, 10, 1200);
    const matches = files
      .filter((filePath) => filePath.toLowerCase().includes(normalizedQuery))
      .slice(0, normalizedLimit);

    return {
      ok: true,
      summary: `found ${matches.length} file match${matches.length === 1 ? "" : "es"}`,
      content: matches.join("\n") || "No matching files.",
      tool: "find_files",
      category: toolSpecs.find_files.category,
      metadata: {
        query: normalizedQuery,
        limit: normalizedLimit,
        truncated: matches.length >= normalizedLimit
      }
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
      summary: `read ${normalizeRelative(this.root, absolutePath)}`,
      content: clippedContent,
      tool: "read_file",
      category: toolSpecs.read_file.category,
      metadata: textContentMetadata(content)
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
      summary: `read ${normalizeRelative(this.root, absolutePath)}:${startLine}-${Math.min(endLine, lines.length)}`,
      content: clip(numberedLines || "No lines in range.", 20_000),
      tool: "read_range",
      category: toolSpecs.read_range.category,
      metadata: {
        path: normalizeRelative(this.root, absolutePath),
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
    const relativePath = normalizeRelative(this.root, absolutePath);
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

  private async inspectDocument(requestedPath: string, mode: string): Promise<ToolResult> {
    if (!requestedPath) {
      return denied("inspect_document requires a path.");
    }

    if (isPlaceholderPath(requestedPath)) {
      return denied(`inspect_document denied placeholder path: ${requestedPath}`);
    }

    if (isSensitivePath(requestedPath)) {
      return denied(`inspect_document denied sensitive path: ${requestedPath}`);
    }

    const { absolutePath, external } = await this.resolveDocumentPath(requestedPath);
    if (external) {
      const approval = await this.requestApproval(
        "inspect_document",
        "external_file",
        {
          path: absolutePath
        },
        `Inspect external file: ${absolutePath}`
      );
      if (approval.decision === "deny") {
        return denied("inspect_document denied by permission policy.", "inspect_document", approval);
      }
    }
    const extension = path.extname(absolutePath).toLowerCase();
    if (isLikelyTextFile(absolutePath)) {
      return await this.readTextDocument(absolutePath);
    }

    const normalizedMode = normalizeDocumentInspectionMode(mode);
    const wantsLocalOnly = normalizedMode === "local" || normalizedMode === "ocr";

    if (extension === ".pdf") {
      const pdfFallback = await extractPdfText(absolutePath, this.timeoutMs, this.signal);
      if (wantsLocalOnly || !this.documentAnalyzer || hasUsefulExtractedText(pdfFallback)) {
        return pdfFallback;
      }

      const providerResult = await this.analyzeDocumentWithProvider(absolutePath, "Analyze this PDF for PatchPilot. Extract readable text, describe structure, and note important visual or scanned content.");
      if (providerResult.ok) {
        return providerResult;
      }
      return mergeFallbackDocumentResult(providerResult, pdfFallback);
    }

    if (extension === ".docx") {
      const docxFallback = await extractDocxText(absolutePath);
      if (wantsLocalOnly || !this.documentAnalyzer || hasUsefulExtractedText(docxFallback)) {
        return docxFallback;
      }

      const providerResult = await this.analyzeDocumentWithProvider(absolutePath, "Analyze this DOCX for PatchPilot. Extract the relevant text, headings, and document structure.");
      if (providerResult.ok) {
        return providerResult;
      }
      return mergeFallbackDocumentResult(providerResult, docxFallback);
    }

    if (extension === ".doc") {
      const docFallback = await extractLegacyDocText(absolutePath, this.timeoutMs, this.signal);
      if (wantsLocalOnly || !this.documentAnalyzer || hasUsefulExtractedText(docFallback)) {
        return docFallback;
      }

      const providerResult = await this.analyzeDocumentWithProvider(absolutePath, "Analyze this Word document for PatchPilot. Extract the relevant text, headings, and document structure.");
      if (providerResult.ok) {
        return providerResult;
      }
      return mergeFallbackDocumentResult(providerResult, docFallback);
    }

    if (isImageFile(absolutePath)) {
      return await inspectImageFile(absolutePath, wantsLocalOnly ? undefined : this.documentAnalyzer, this.signal, normalizedMode, this.providerAnalysisTimeoutMs());
    }

    return denied(`inspect_document does not support ${extension || "this file type"} yet.`);
  }

  private async readTextDocument(absolutePath: string): Promise<ToolResult> {
    const content = await readFile(absolutePath, "utf8");
    const rawRelativePath = path.relative(this.root, absolutePath);
    const relativePath = normalizeRelative(this.root, absolutePath);
    return {
      ok: true,
      summary: `inspected ${rawRelativePath.startsWith("..") || path.isAbsolute(rawRelativePath) ? absolutePath : relativePath}`,
      content: clip(content, 20_000),
      tool: "inspect_document",
      category: toolSpecs.inspect_document.category,
      metadata: textContentMetadata(content)
    };
  }

  private async analyzeDocumentWithProvider(absolutePath: string, prompt: string): Promise<ToolResult> {
    if (!this.documentAnalyzer) {
      return denied("inspect_document has no provider document analyzer configured.", "inspect_document");
    }

    try {
      const analysis = await runDocumentAnalyzer(this.documentAnalyzer, {
        path: absolutePath,
        prompt,
        signal: this.signal
      }, this.providerAnalysisTimeoutMs());
      return {
        ok: true,
        summary: `analyzed ${path.basename(absolutePath)} with provider file input`,
        content: clip(analysis, 20_000),
        tool: "inspect_document",
        category: toolSpecs.inspect_document.category
      };
    } catch (error) {
      return denied(`provider file analysis failed for ${path.basename(absolutePath)}: ${error instanceof Error ? error.message : String(error)}`, "inspect_document");
    }
  }

  private providerAnalysisTimeoutMs(): number {
    return Math.min(this.timeoutMs, 90_000);
  }

  private async memoryRemember(content: string, tags: string[]): Promise<ToolResult> {
    if (!this.memoryEnabled) {
      return denied("memory_remember requires /experimental memory.", "memory_remember");
    }

    if (!this.allowWrite) {
      const approval = await this.requestApproval(
        "memory_remember",
        "write",
        {
          contentLength: content.length,
          tags
        },
        `Store durable memory (${content.length} characters).`
      );
      if (approval.decision === "deny") {
        return denied("memory_remember denied by permission policy.", "memory_remember", approval);
      }
    }

    try {
      const store = new MemoryStore();
      const entry = store.remember(this.root, content, tags);
      store.close();
      return {
        ok: true,
        summary: `remembered memory #${entry.id}`,
        content: `Stored memory #${entry.id}: ${entry.content}`,
        tool: "memory_remember",
        category: toolSpecs.memory_remember.category
      };
    } catch (error) {
      return denied(error instanceof Error ? error.message : String(error), "memory_remember");
    }
  }

  private async memorySearch(query: string, limit: number): Promise<ToolResult> {
    if (!this.memoryEnabled) {
      return denied("memory_search requires /experimental memory.", "memory_search");
    }

    const store = new MemoryStore();
    const matches = store.search(this.root, query, limit);
    store.close();
    return {
      ok: true,
      summary: `found ${matches.length} memory match${matches.length === 1 ? "" : "es"}`,
      content: matches.map((match) => `#${match.id} score ${match.score} ${match.createdAt}\n${match.content}`).join("\n\n") || "No matching memories.",
      tool: "memory_search",
      category: toolSpecs.memory_search.category
    };
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

  private async fetchUrl(rawUrl: string, requestedMaxChars: number): Promise<ToolResult> {
    if (!rawUrl.trim()) {
      return denied("fetch_url requires a url.", "fetch_url");
    }

    const normalizedUrl = normalizeFetchUrlInput(rawUrl);
    if (!normalizedUrl) {
      return denied(`fetch_url could not parse url: ${rawUrl.trim()}`, "fetch_url");
    }

    let target: URL;
    try {
      target = new URL(normalizedUrl);
    } catch {
      return denied(`fetch_url could not parse url: ${normalizedUrl}`, "fetch_url");
    }

    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return denied(`fetch_url only allows http(s) URLs, got ${target.protocol}`, "fetch_url");
    }

    try {
      await assertPublicHttpHost(target.hostname);
    } catch (error) {
      return denied(error instanceof Error ? error.message : String(error), "fetch_url");
    }

    // Network egress can exfiltrate workspace data, so gate it like shell: it
    // bypasses approval only when shell is trusted (build+bypass), prompts in
    // build mode, and is blocked in plan mode.
    if (!this.allowShell) {
      const approval = await this.requestApproval(
        "fetch_url",
        "network",
        { url: target.href },
        `Fetch ${target.href} over the network.`
      );
      if (approval.decision === "deny") {
        return denied("fetch_url denied by permission policy. Approve the request, or switch to build/bypass.", "fetch_url", approval);
      }
    }

    const maxChars = requestedMaxChars > 0 ? Math.min(requestedMaxChars, fetchUrlMaxChars) : fetchUrlMaxChars;
    let response: Response;
    try {
      response = await fetchWithTimeout(
        target,
        {
          redirect: "manual",
          signal: this.signal,
          headers: {
            // Identify as a normal client so most sites return readable HTML.
            "user-agent": "Mozilla/5.0 (compatible; PatchPilot/1.0; +https://github.com/jx-grxf/PatchPilot)",
            accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8"
          }
        },
        { timeoutMs: Math.min(this.timeoutMs, fetchUrlTimeoutMs), label: `fetch_url ${target.hostname}` }
      );
    } catch (error) {
      return denied(error instanceof Error ? error.message : String(error), "fetch_url");
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location") ?? "";
      const redirectSuffix = location ? ` Location: ${location}` : "";
      return {
        ok: true,
        summary: `${target.href} -> HTTP ${response.status} redirect`,
        content: `fetch_url did not follow the redirect automatically (SSRF guard). HTTP ${response.status}.${redirectSuffix}\nRe-call fetch_url with the absolute redirect target if it is a public http(s) URL.`,
        tool: "fetch_url",
        category: toolSpecs.fetch_url.category,
        metadata: { status: response.status, location }
      };
    }

    const contentType = response.headers.get("content-type") ?? "";
    const rawBody = await response.text().catch(() => "");
    const isHtml = /\bhtml\b/i.test(contentType) || (!contentType && /^\s*<(?:!doctype|html)/i.test(rawBody));
    const extracted = isHtml ? htmlToReadableText(rawBody) : rawBody.trim();
    const truncated = extracted.length > maxChars;
    const body = truncated ? `${extracted.slice(0, maxChars)}\n… [truncated ${extracted.length - maxChars} more chars]` : extracted;

    if (!response.ok) {
      return {
        ok: false,
        summary: `${target.href} -> HTTP ${response.status}`,
        content: `fetch_url received HTTP ${response.status} from ${target.href}.\n${body}`.trim(),
        tool: "fetch_url",
        category: toolSpecs.fetch_url.category,
        metadata: { status: response.status, contentType }
      };
    }

    return {
      ok: true,
      summary: `fetched ${target.href} (HTTP ${response.status}, ${extracted.length} chars${truncated ? ", truncated" : ""})`,
      content: body || "(empty response body)",
      tool: "fetch_url",
      category: toolSpecs.fetch_url.category,
      metadata: { status: response.status, contentType, chars: extracted.length, truncated }
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

    const absolutePath = await this.resolveWritePath(requestedPath);
    const normalized = normalizePossiblyEscapedFileContent(content, absolutePath);

    if (!this.allowWrite) {
      const approval = await this.requestApproval("write_file", "write", {
        path: requestedPath,
        contentLength: normalized.content.length
      }, `Write ${requestedPath} (${normalized.content.length} characters).`);
      if (approval.decision === "deny") {
        return denied("write_file denied by permission policy. Restart with --apply or approve the request in build mode.", "write_file", approval);
      }
    }

    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, normalized.content, "utf8");

    return {
      ok: true,
      summary: `wrote ${normalizeRelative(this.root, absolutePath)}`,
      content: `Wrote ${normalized.content.length} characters.${normalized.normalized ? " Normalized escaped newlines before writing." : ""}`,
      tool: "write_file",
      category: toolSpecs.write_file.category,
      preview: `Write ${normalizeRelative(this.root, absolutePath)}`,
      metadata: {
        normalizedEscapedContent: normalized.normalized
      }
    };
  }

  private async createPdf(requestedPath: string, content: string, title: string): Promise<ToolResult> {
    if (!requestedPath) {
      return denied("create_pdf requires a path.", "create_pdf");
    }

    const targetPath = requestedPath.toLowerCase().endsWith(".pdf") ? requestedPath : `${requestedPath}.pdf`;
    const approval = await this.requestWriteApproval("create_pdf", targetPath, content.length, "Create PDF");
    if (approval) {
      return approval;
    }

    const absolutePath = await this.resolveWritePath(targetPath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    const pdf = createSimplePdf(content, title || path.basename(targetPath, ".pdf"));
    await writeFile(absolutePath, pdf);

    return {
      ok: true,
      summary: `created PDF ${normalizeRelative(this.root, absolutePath)}`,
      content: `Created ${pdf.length} byte PDF from ${content.length} characters.`,
      tool: "create_pdf",
      category: toolSpecs.create_pdf.category,
      preview: `Create PDF ${normalizeRelative(this.root, absolutePath)}`
    };
  }

  private async createDocx(requestedPath: string, content: string, title: string): Promise<ToolResult> {
    if (!requestedPath) {
      return denied("create_docx requires a path.", "create_docx");
    }

    const targetPath = requestedPath.toLowerCase().endsWith(".docx") ? requestedPath : `${requestedPath}.docx`;
    const approval = await this.requestWriteApproval("create_docx", targetPath, content.length, "Create DOCX");
    if (approval) {
      return approval;
    }

    const absolutePath = await this.resolveWritePath(targetPath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    const docx = createSimpleDocx(content, title);
    await writeFile(absolutePath, docx);

    return {
      ok: true,
      summary: `created DOCX ${normalizeRelative(this.root, absolutePath)}`,
      content: `Created ${docx.length} byte DOCX from ${content.length} characters.`,
      tool: "create_docx",
      category: toolSpecs.create_docx.category,
      preview: `Create DOCX ${normalizeRelative(this.root, absolutePath)}`
    };
  }

  private async requestWriteApproval(tool: "create_pdf" | "create_docx", requestedPath: string, contentLength: number, action: string): Promise<ToolResult | null> {
    if (isPlaceholderPath(requestedPath)) {
      return denied(`${tool} denied placeholder path: ${requestedPath}`, tool);
    }

    if (isSensitivePath(requestedPath)) {
      return denied(`${tool} denied sensitive path: ${requestedPath}`, tool);
    }

    if (this.allowWrite) {
      return null;
    }

    const approval = await this.requestApproval(tool, "write", {
      path: requestedPath,
      contentLength
    }, `${action} ${requestedPath} (${contentLength} characters).`);
    if (approval.decision === "deny") {
      return denied(`${tool} denied by permission policy. Restart with --apply or approve the request in build mode.`, tool, approval);
    }

    return null;
  }

  private async editFile(requestedPath: string, findText: string, replaceText: string, startLine: number, endLine: number, replacementText: string, expectedText: string | undefined): Promise<ToolResult> {
    if (!requestedPath) {
      return denied("edit_file requires a path.", "edit_file");
    }

    if (isPlaceholderPath(requestedPath)) {
      return denied(`edit_file denied placeholder path: ${requestedPath}`, "edit_file");
    }

    if (isSensitivePath(requestedPath)) {
      return denied(`edit_file denied sensitive path: ${requestedPath}`, "edit_file");
    }

    const usesLineRange = startLine > 0 || endLine > 0;
    const usesFindReplace = findText.length > 0;
    if (usesLineRange === usesFindReplace) {
      return denied("edit_file requires either find/replace or startLine/endLine/replacement.", "edit_file");
    }

    if (usesLineRange && (startLine < 1 || endLine < startLine)) {
      return denied("edit_file requires 1-based startLine/endLine values.", "edit_file");
    }

    const absolutePath = await this.resolveWritePath(requestedPath);
    if (!isLikelyTextFile(absolutePath)) {
      return denied(`edit_file supports text/code files. Use write_file only when replacing the full ${path.extname(absolutePath) || "file"} file is intentional.`, "edit_file");
    }

    const originalContent = await readFile(absolutePath, "utf8").catch((error: unknown) => {
      throw new Error(`file not found or unreadable: ${requestedPath} (${error instanceof Error ? error.message : String(error)})`);
    });
    const normalizedReplaceText = normalizePossiblyEscapedFileContent(replaceText, absolutePath).content;
    const normalizedReplacementText = normalizePossiblyEscapedFileContent(replacementText, absolutePath).content;
    const normalizedExpectedText = expectedText === undefined ? undefined : normalizePossiblyEscapedFileContent(expectedText, absolutePath).content;
    let nextContent = originalContent;
    let editSummary = "";

    if (usesFindReplace) {
      const matches = countOccurrences(originalContent, findText);
      if (matches !== 1) {
        return denied(`edit_file find text must match exactly once; found ${matches} matches.`, "edit_file");
      }
      nextContent = originalContent.replace(findText, normalizedReplaceText);
      editSummary = `replaced 1 match in ${normalizeRelative(this.root, absolutePath)}`;
    } else {
      const lines = originalContent.split(/\r?\n/);
      if (endLine > lines.length) {
        return denied(`edit_file line range exceeds file length (${lines.length} lines).`, "edit_file");
      }
      const replacementLines = normalizedReplacementText.split(/\r?\n/);
      const currentRange = lines.slice(startLine - 1, endLine).join("\n");
      if (normalizedExpectedText !== undefined && currentRange !== normalizedExpectedText) {
        return denied("edit_file expected content did not match the current line range.", "edit_file");
      }
      lines.splice(startLine - 1, endLine - startLine + 1, ...replacementLines);
      nextContent = lines.join("\n");
      editSummary = `replaced lines ${startLine}-${endLine} in ${normalizeRelative(this.root, absolutePath)}`;
    }

    if (nextContent === originalContent) {
      return denied("edit_file produced no changes.", "edit_file");
    }

    if (!this.allowWrite) {
      const approval = await this.requestApproval(
        "edit_file",
        "write",
        {
          path: requestedPath,
          startLine: usesLineRange ? startLine : undefined,
          endLine: usesLineRange ? endLine : undefined,
          findLength: usesFindReplace ? findText.length : undefined,
          expectedLength: normalizedExpectedText?.length,
          replacementLength: usesLineRange ? normalizedReplacementText.length : normalizedReplaceText.length
        },
        `Edit ${requestedPath}: ${editSummary}`
      );
      if (approval.decision === "deny") {
        return denied("edit_file denied by permission policy. Restart with --apply or approve the request in build mode.", "edit_file", approval);
      }
    }

    await writeFile(absolutePath, nextContent, "utf8");

    return {
      ok: true,
      summary: editSummary,
      content: `Edited ${normalizeRelative(this.root, absolutePath)}.`,
      tool: "edit_file",
      category: toolSpecs.edit_file.category,
      preview: `Edit ${normalizeRelative(this.root, absolutePath)}`
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

  private async gitLog(limit: number): Promise<ToolResult> {
    const normalizedLimit = Math.max(1, Math.min(50, Math.floor(limit || 8)));
    const { stdout } = await execFileAsync("git", ["log", "--oneline", "--decorate", `--max-count=${normalizedLimit}`], {
      cwd: this.root,
      timeout: Math.min(this.timeoutMs, 8000),
      maxBuffer: 200_000,
      signal: this.signal,
      windowsHide: true
    });

    return {
      ok: true,
      summary: `read ${normalizedLimit} git commit${normalizedLimit === 1 ? "" : "s"}`,
      content: stdout.trim() || "No commits found.",
      tool: "git_log",
      category: toolSpecs.git_log.category
    };
  }

  private async gitShow(revision: string, requestedPath: string): Promise<ToolResult> {
    const normalizedRevision = revision.trim() || "HEAD";
    if (!/^[A-Za-z0-9_./:@{}^~+-]+$/.test(normalizedRevision)) {
      return denied("git_show revision contains unsupported characters.", "git_show");
    }

    const args = ["show", "--stat", "--oneline", "--decorate", "--no-ext-diff", normalizedRevision, "--"];
    if (requestedPath.trim()) {
      const absolutePath = this.resolveInsideWorkspace(requestedPath);
      args.push(path.relative(this.root, absolutePath));
    }

    const { stdout } = await execFileAsync("git", args, {
      cwd: this.root,
      timeout: Math.min(this.timeoutMs, 8000),
      maxBuffer: 500_000,
      signal: this.signal,
      windowsHide: true
    });

    return {
      ok: true,
      summary: `read git revision ${normalizedRevision}`,
      content: clip(stdout.trim() || "No revision output.", 20_000),
      tool: "git_show",
      category: toolSpecs.git_show.category
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

  private async repoOverview(): Promise<ToolResult> {
    const packageJson: Record<string, unknown> = await this.readPackageJsonObject().catch(() => ({}));
    const rootRealPath = await this.rootRealPath;
    const files = await walkFiles(this.root, this.root, rootRealPath, 1, 80).catch(() => []);
    const gitStatus = await execFileAsync("git", ["status", "--short", "--branch"], {
      cwd: this.root,
      timeout: Math.min(this.timeoutMs, 5000),
      maxBuffer: 100_000,
      signal: this.signal,
      windowsHide: true
    }).then((result) => result.stdout.trim()).catch(() => "No git repository detected.");
    const scripts = Object.keys(readStringRecord(packageJson.scripts)).sort();
    const dependencies = Object.keys(readStringRecord(packageJson.dependencies)).length;
    const devDependencies = Object.keys(readStringRecord(packageJson.devDependencies)).length;

    return {
      ok: true,
      summary: "read repository overview",
      content: [
        `name: ${typeof packageJson.name === "string" ? packageJson.name : path.basename(this.root)}`,
        `version: ${typeof packageJson.version === "string" ? packageJson.version : "unknown"}`,
        `description: ${typeof packageJson.description === "string" ? packageJson.description : "none"}`,
        `scripts: ${scripts.join(", ") || "none"}`,
        `dependencies: ${dependencies} runtime, ${devDependencies} dev`,
        "",
        "git:",
        gitStatus || "clean",
        "",
        "top-level files:",
        files.join("\n") || "No files found."
      ].join("\n"),
      tool: "repo_overview",
      category: toolSpecs.repo_overview.category
    };
  }

  private async testList(): Promise<ToolResult> {
    const packageJson: Record<string, unknown> = await this.readPackageJsonObject().catch(() => ({}));
    const scripts = Object.entries(readStringRecord(packageJson.scripts))
      .filter(([name, command]) => /test|spec|vitest|jest|playwright|check/i.test(`${name} ${command}`))
      .sort(([left], [right]) => left.localeCompare(right));
    const files = await walkFiles(this.root, this.root, await this.rootRealPath, 8, 500).catch(() => []);
    const testFiles = files.filter((filePath) => /(^|\/)(__tests__|tests?|specs?)\/|[.-](test|spec)\.[cm]?[jt]sx?$|\.test\./i.test(filePath));

    return {
      ok: true,
      summary: `listed ${testFiles.length} likely test file${testFiles.length === 1 ? "" : "s"}`,
      content: [
        "test scripts:",
        scripts.map(([name, command]) => `${name}: ${command}`).join("\n") || "No test-related scripts found.",
        "",
        "test files:",
        testFiles.slice(0, 120).join("\n") || "No likely test files found."
      ].join("\n"),
      tool: "test_list",
      category: toolSpecs.test_list.category
    };
  }

  private async dependencyTree(): Promise<ToolResult> {
    const packageJson = await this.readPackageJsonObject();
    const sections: Array<[string, Record<string, string>]> = [
      ["dependencies", readStringRecord(packageJson.dependencies)],
      ["devDependencies", readStringRecord(packageJson.devDependencies)],
      ["peerDependencies", readStringRecord(packageJson.peerDependencies)],
      ["optionalDependencies", readStringRecord(packageJson.optionalDependencies)]
    ];
    const content = sections
      .map(([sectionName, dependencies]) => {
        const entries = Object.entries(dependencies).sort(([left], [right]) => left.localeCompare(right));
        return [`${sectionName}:`, entries.map(([name, version]) => `- ${name}@${version}`).join("\n") || "- none"].join("\n");
      })
      .join("\n\n");

    return {
      ok: true,
      summary: "read dependency tree",
      content,
      tool: "dependency_tree",
      category: toolSpecs.dependency_tree.category
    };
  }

  private async applyPatch(patchContent: string): Promise<ToolResult> {
    if (!patchContent.trim()) {
      return denied("apply_patch requires a unified patch.", "apply_patch");
    }

    const validationError = await this.validatePatchTargets(patchContent);
    if (validationError) {
      return denied(validationError, "apply_patch");
    }

    if (!this.allowWrite) {
      const approval = await this.requestApproval(
        "apply_patch",
        "write",
        {
          patch: clip(patchContent, 1200),
          patchHash: stableHash(patchContent)
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
    return await this.runPackageScript("run_script", scriptName);
  }

  private async runTests(): Promise<ToolResult> {
    return await this.runPackageScript("run_tests", "test");
  }

  private async runPackageScript(tool: "run_script" | "run_tests", scriptName: string): Promise<ToolResult> {
    const normalizedScript = scriptName.trim();
    if (!/^[\w:.-]+$/.test(normalizedScript)) {
      return denied(`${tool} requires a package script name such as test or build.`, tool);
    }

    const scripts = await this.readPackageScripts();
    if (!scripts[normalizedScript]) {
      return denied(`package script not found: ${normalizedScript}`, tool);
    }

    const scriptCommands = collectPackageScriptCommands(scripts, normalizedScript);
    const scriptSafetyError = validatePackageScriptCommands(scriptCommands, this.root);
    if (scriptSafetyError) {
      return denied(`${tool} denied package script before approval. ${scriptSafetyError}`, tool);
    }
    const approvalCommand = scriptCommands.map((entry) => `${entry.name}: ${entry.command}`).join("\n");

    if (!this.allowShell) {
      const approval = await this.requestApproval(
        tool,
        "shell",
        {
          script: normalizedScript,
          command: approvalCommand
        },
        previewPackageScriptSequence(normalizedScript, scriptCommands, this.root)
      );
      if (approval.decision === "deny") {
        return denied(`${tool} denied by permission policy.`, tool, approval);
      }
    }

    const output = await runCommand(`npm run ${normalizedScript}`, this.root, this.timeoutMs, this.signal);
    return {
      ok: output.exitCode === 0,
      summary: `npm run ${normalizedScript} exited ${output.exitCode}`,
      content: clip(output.output, 20_000),
      tool,
      category: toolSpecs[tool].category,
      preview: previewPackageScriptSequence(normalizedScript, scriptCommands, this.root)
    };
  }

  private async runShell(command: string): Promise<ToolResult> {
    if (!command.trim()) {
      return denied("run_shell requires a command.");
    }

    const shellSafety = validateShellCommand(command, this.root, {
      allowMetacharacters: this.allowShellMetacharacters
    });
    if (shellSafety.error) {
      return denied(`run_shell denied. ${shellSafety.error}`);
    }

    const shellPathError = await this.validateShellPathArguments(command);
    if (shellPathError) {
      return denied(`run_shell denied. ${shellPathError}`);
    }

    if (!this.allowShell || shellSafety.requiresApprovalReason) {
      const approval = await this.requestApproval(
        "run_shell",
        "shell",
        {
          command,
          ...(shellSafety.requiresApprovalReason ? { approvalReason: shellSafety.requiresApprovalReason } : {})
        },
        shellSafety.requiresApprovalReason
          ? `High-risk shell command (${shellSafety.requiresApprovalReason}): ${command}`
          : `Run shell command: ${command}`,
        {
          bypassable: !shellSafety.requiresApprovalReason
        }
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
    const packageJson = await this.readPackageJsonObject();
    return Object.fromEntries(Object.entries(packageJson.scripts ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  }

  private async readPackageJsonObject(): Promise<Record<string, unknown> & { scripts?: Record<string, unknown> }> {
    const packageJsonPath = await this.resolveReadPath("package.json");
    return JSON.parse(await readFile(packageJsonPath, "utf8")) as Record<string, unknown> & { scripts?: Record<string, unknown> };
  }

  private async requestApproval(
    tool: AgentToolName,
    permission: Exclude<ToolPermission, "none">,
    args: Record<string, unknown>,
    preview: string,
    options: { bypassable?: boolean } = {}
  ): Promise<{ request: ApprovalRequest; decision: PermissionDecision }> {
    const spec = getToolSpec(tool);
    const request: ApprovalRequest = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      tool,
      permission,
      risk: spec.risk,
      preview,
      arguments: args,
      bypassable: options.bypassable
    };

    const approvalKey = approvalScopeKey(tool, permission, args);
    if (this.sessionApprovals.has(approvalKey)) {
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
      this.sessionApprovals.add(approvalKey);
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
    await this.assertSafeResolvedWorkspacePath(resolvedPath, requestedPath);
    return resolvedPath;
  }

  private async resolveDocumentPath(requestedPath: string): Promise<{ absolutePath: string; external: boolean }> {
    const trimmedPath = requestedPath.trim();
    if (!path.isAbsolute(trimmedPath)) {
      return {
        absolutePath: await this.resolveReadPath(trimmedPath),
        external: false
      };
    }

    if (isSensitivePath(trimmedPath)) {
      throw new Error(`inspect_document denied sensitive path: ${requestedPath}`);
    }

    const relativePath = path.relative(this.root, trimmedPath);
    if (!relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
      return {
        absolutePath: await this.resolveReadPath(trimmedPath),
        external: false
      };
    }

    if (!this.allowExternalFileAnalysis) {
      throw new Error(`Path escapes workspace: ${requestedPath}. Enable /experimental file-analysis to inspect external files.`);
    }

    const extension = path.extname(trimmedPath).toLowerCase();
    if (!isLikelyTextFile(trimmedPath) && extension !== ".pdf" && extension !== ".docx" && extension !== ".doc" && !isImageFile(trimmedPath)) {
      throw new Error(`external file analysis does not support ${extension || "this file type"} yet.`);
    }

    const resolvedPath = await realpath(trimmedPath).catch((error: unknown) => {
      throw new Error(`file not found or unreadable: ${requestedPath} (${error instanceof Error ? error.message : String(error)})`);
    });
    if (isSensitivePath(resolvedPath)) {
      throw new Error(`inspect_document denied sensitive path: ${requestedPath}`);
    }

    return {
      absolutePath: resolvedPath,
      external: true
    };
  }

  private async resolveWritePath(requestedPath: string): Promise<string> {
    const absolutePath = this.resolveInsideWorkspace(requestedPath);
    const rootRealPath = await this.rootRealPath;
    const existingParent = await findNearestExistingParent(absolutePath);
    const parentRealPath = await realpath(existingParent);
    await assertInsideWorkspace(rootRealPath, parentRealPath, requestedPath);
    assertNotSensitiveResolvedPath(rootRealPath, parentRealPath, requestedPath);

    const targetStat = await lstat(absolutePath).catch(() => null);
    if (targetStat) {
      const resolvedTargetPath = await realpath(absolutePath).catch((error: unknown) => {
        throw new Error(`file not writable: ${requestedPath} (${error instanceof Error ? error.message : String(error)})`);
      });
      await this.assertSafeResolvedWorkspacePath(resolvedTargetPath, requestedPath);
    }

    return absolutePath;
  }

  private async assertSafeResolvedWorkspacePath(resolvedPath: string, requestedPath: string): Promise<void> {
    const rootRealPath = await this.rootRealPath;
    await assertInsideWorkspace(rootRealPath, resolvedPath, requestedPath);
    assertNotSensitiveResolvedPath(rootRealPath, resolvedPath, requestedPath);
  }

  private async validatePatchTargets(patchContent: string): Promise<string | null> {
    if (patchCreatesSymlink(patchContent)) {
      return "apply_patch denied symlink patches.";
    }

    for (const targetPath of extractPatchTargetPaths(patchContent)) {
      if (isPlaceholderPath(targetPath)) {
        return `apply_patch denied placeholder path: ${targetPath}`;
      }

      if (isSensitivePath(targetPath) || targetPath === ".patchpilot" || targetPath.startsWith(".patchpilot/")) {
        return `apply_patch denied sensitive path: ${targetPath}`;
      }

      try {
        const absolutePath = this.resolveInsideWorkspace(targetPath);
        const existingPath = await realpath(absolutePath).catch(() => null);
        if (existingPath) {
          await this.assertSafeResolvedWorkspacePath(existingPath, targetPath);
        } else {
          const parentRealPath = await realpath(await findNearestExistingParent(absolutePath));
          await assertInsideWorkspace(await this.rootRealPath, parentRealPath, targetPath);
          assertNotSensitiveResolvedPath(await this.rootRealPath, parentRealPath, targetPath);
        }
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }

    return null;
  }

  private async validateShellPathArguments(command: string): Promise<string | null> {
    const tokens = tokenizeShellCommand(command);
    for (const segment of splitPipeline(tokens)) {
      for (const token of segment.slice(1)) {
        const normalizedToken = stripQuotes(token);
        if (!normalizedToken || shellOperatorTokens.has(normalizedToken) || normalizedToken.startsWith("-")) {
          continue;
        }

        const absolutePath = toAbsoluteShellPath(normalizedToken) ?? path.resolve(this.root, normalizedToken);
        const existingPath = await lstat(absolutePath).catch(() => null);
        if (!existingPath) {
          continue;
        }

        try {
          const resolvedPath = await realpath(absolutePath);
          await this.assertSafeResolvedWorkspacePath(resolvedPath, normalizedToken);
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      }
    }

    return null;
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
      "!**/known_hosts",
      "!**/Cookies",
      "!**/Network/Cookies",
      "!**/Login Data",
      "!**/Web Data",
      "!**/Chrome/**",
      "!**/Chromium/**",
      "!**/Brave*/**",
      "!**/Microsoft Edge/**",
      "!**/Arc/**",
      "!**/Firefox/**",
      "!**/Safari/**"
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

function assertNotSensitiveResolvedPath(workspaceRealRoot: string, candidatePath: string, requestedPath: string): void {
  const relativePath = normalizeSlashPath(path.relative(workspaceRealRoot, candidatePath));
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return;
  }

  if (isSensitivePath(relativePath) || relativePath === ".patchpilot" || relativePath.startsWith(".patchpilot/")) {
    throw new Error(`Path resolves to sensitive workspace path: ${requestedPath}`);
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
  const shellArgs = isWindows ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command] : ["-lc", command];

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

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function countOccurrences(value: string, needle: string): number {
  if (!needle) {
    return 0;
  }

  let count = 0;
  let index = 0;
  while (true) {
    index = value.indexOf(needle, index);
    if (index === -1) {
      return count;
    }
    count += 1;
    index += needle.length;
  }
}

function normalizePossiblyEscapedFileContent(content: string, filePath: string): { content: string; normalized: boolean } {
  if (!shouldDecodeEscapedFileContent(content, filePath)) {
    return {
      content,
      normalized: false
    };
  }

  const decoded = decodeCommonJsonStringEscapes(content);
  return {
    content: decoded,
    normalized: decoded !== content
  };
}

function shouldDecodeEscapedFileContent(content: string, filePath: string): boolean {
  const escapedNewlines = countOccurrences(content, "\\n");
  if (escapedNewlines === 0) {
    return false;
  }

  const realNewlines = countOccurrences(content, "\n");
  if (realNewlines > 0 && realNewlines >= escapedNewlines) {
    return false;
  }

  const extension = path.extname(filePath).toLowerCase();
  const likelySourceOrMarkup = textFileExtensions.has(extension);
  if (!likelySourceOrMarkup) {
    return false;
  }

  const hasEscapedQuotes = content.includes('\\"') || content.includes("\\'");
  const hasSourceMarkers = /(?:<!doctype|<html|<\/\w+>|function\s|const\s|let\s|class\s|import\s|export\s|{\s*\\n|;\s*\\n|#\s|\/\*)/i.test(content);
  return hasEscapedQuotes || escapedNewlines >= 2 || hasSourceMarkers;
}

function decodeCommonJsonStringEscapes(content: string): string {
  return content
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, "\"")
    .replace(/\\'/g, "'");
}

function textContentMetadata(content: string): Record<string, number> {
  const realNewlines = countOccurrences(content, "\n");
  return {
    lineCount: content.length === 0 ? 0 : realNewlines + 1,
    realNewlines,
    literalBackslashN: countOccurrences(content, "\\n"),
    literalEscapedQuotes: countOccurrences(content, '\\"')
  };
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

function readStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }

  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }

  return [];
}

function isPlaceholderPath(value: string): boolean {
  const normalizedValue = value.trim().toLowerCase().replaceAll("\\", "/");
  return ["relative/path", "path/to/file", "file/path", "<path>", "<file>", "filename"].includes(normalizedValue);
}

export function isSensitivePath(value: string): boolean {
  const normalizedPath = value.trim().replaceAll("\\", "/");
  return normalizedPath
    .split("/")
    .filter(Boolean)
    .some((part) => {
      const normalizedPart = part.toLowerCase();
      return (
        blockedPathNames.has(normalizedPart) ||
        normalizedPart.endsWith(".pem") ||
        normalizedPart.endsWith(".key") ||
        normalizedPart.endsWith(".p12") ||
        normalizedPart.endsWith(".pfx") ||
        normalizedPart.startsWith("secrets.") ||
        normalizedPart.includes("credentials")
      );
    }) || blockedPathPatterns.some((pattern) => pattern.test(normalizedPath));
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

const fetchUrlMaxChars = 20_000;
const fetchUrlTimeoutMs = 20_000;

/**
 * Models (especially Gemini) often hand back a URL wrapped in Markdown link
 * syntax, angle brackets, quotes, or as a bare domain. Recover a plain absolute
 * http(s) URL from those common shapes before parsing.
 */
function normalizeFetchUrlInput(raw: string): string {
  let value = raw.trim();

  // Markdown link: [label](url) -> url
  const markdownLink = /\[[^\]]*\]\(\s*([^)\s]+)\s*\)/.exec(value);
  if (markdownLink) {
    value = markdownLink[1];
  }

  // Strip wrapping angle brackets, quotes, and backticks.
  value = value.replace(/^[<'"`]+/, "").replace(/[>'"`]+$/, "").trim();
  // Drop trailing sentence punctuation that is rarely part of a real URL.
  value = value.replace(/[.,;]+$/, "").trim();

  if (!value) {
    return "";
  }

  // Add a scheme for bare domains like "example.com" or "example.com/path".
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && /^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$|\?)/.test(value)) {
    value = `https://${value}`;
  }

  return value;
}

/**
 * Reject non-public fetch targets so fetch_url cannot be used for SSRF against
 * loopback, LAN, link-local, or cloud-metadata endpoints. Resolves DNS names so
 * a public-looking host that points at a private address is still blocked.
 */
async function assertPublicHttpHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) {
    throw new Error("fetch_url blocked an empty host.");
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error(`fetch_url blocked a non-public host: ${hostname}`);
  }

  if (isIP(host)) {
    if (isPrivateAddress(host)) {
      throw new Error(`fetch_url blocked a private address: ${hostname}`);
    }
    return;
  }

  let resolved: { address: string }[];
  try {
    resolved = await lookup(host, { all: true });
  } catch (error) {
    throw new Error(`fetch_url could not resolve host ${hostname}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (resolved.length === 0) {
    throw new Error(`fetch_url could not resolve host ${hostname}.`);
  }
  for (const entry of resolved) {
    if (isPrivateAddress(entry.address)) {
      throw new Error(`fetch_url blocked ${hostname} -> private address ${entry.address}.`);
    }
  }
}

function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return isPrivateIPv4(address);
  }
  if (family === 6) {
    return isPrivateIPv6(address);
  }
  return true;
}

function isPrivateIPv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return true;
  }
  const value = (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
  const inRange = (start: number, prefix: number): boolean => {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return ((value & mask) >>> 0) === ((start & mask) >>> 0);
  };
  return (
    inRange(0x00000000, 8) || // 0.0.0.0/8 "this network"
    inRange(0x0a000000, 8) || // 10.0.0.0/8 private
    inRange(0x64400000, 10) || // 100.64.0.0/10 CGNAT
    inRange(0x7f000000, 8) || // 127.0.0.0/8 loopback
    inRange(0xa9fe0000, 16) || // 169.254.0.0/16 link-local + metadata
    inRange(0xac100000, 12) || // 172.16.0.0/12 private
    inRange(0xc0a80000, 16) || // 192.168.0.0/16 private
    inRange(0xc0000000, 24) || // 192.0.0.0/24 IETF protocol
    inRange(0xc6120000, 15) || // 198.18.0.0/15 benchmarking
    inRange(0xe0000000, 4) || // 224.0.0.0/4 multicast
    inRange(0xf0000000, 4) // 240.0.0.0/4 reserved
  );
}

function isPrivateIPv6(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0];
  if (normalized === "::1" || normalized === "::") {
    return true;
  }
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped) {
    return isPrivateIPv4(mapped[1]);
  }
  const firstHextet = normalized.split(":")[0] ?? "";
  if (firstHextet === "") {
    return false;
  }
  const value = Number.parseInt(firstHextet, 16);
  if (Number.isNaN(value)) {
    return true;
  }
  if ((value & 0xfe00) === 0xfc00) {
    return true; // fc00::/7 unique-local
  }
  if ((value & 0xffc0) === 0xfe80) {
    return true; // fe80::/10 link-local
  }
  if ((value & 0xff00) === 0xff00) {
    return true; // ff00::/8 multicast
  }
  return false;
}

function htmlToReadableText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|header|footer)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t\f\v]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line, index, lines) => line.length > 0 || (index > 0 && lines[index - 1].trim().length > 0))
    .join("\n")
    .trim();
}

function isLikelyTextFile(filePath: string): boolean {
  return textFileExtensions.has(path.extname(filePath).toLowerCase());
}

function isImageFile(filePath: string): boolean {
  return [".png", ".jpg", ".jpeg", ".webp", ".gif", ".heic", ".heif"].includes(path.extname(filePath).toLowerCase());
}

function normalizeDocumentInspectionMode(mode: string): "auto" | "local" | "ocr" {
  const normalizedMode = mode.trim().toLowerCase();
  return normalizedMode === "local" || normalizedMode === "ocr" ? normalizedMode : "auto";
}

function mergeFallbackDocumentResult(providerResult: ToolResult, fallbackResult: ToolResult): ToolResult {
  if (fallbackResult.ok) {
    return {
      ...fallbackResult,
      content: [
        "provider_analysis_error:",
        providerResult.content,
        "",
        "local_fallback:",
        fallbackResult.content
      ].join("\n")
    };
  }

  return providerResult;
}

function hasUsefulExtractedText(result: ToolResult): boolean {
  if (!result.ok) {
    return false;
  }

  const normalizedContent = result.content.trim().toLowerCase();
  return Boolean(normalizedContent) && !normalizedContent.startsWith("no extractable ");
}

async function inspectImageFile(
  filePath: string,
  documentAnalyzer?: DocumentAnalyzer,
  signal?: AbortSignal,
  mode: "auto" | "local" | "ocr" = "auto",
  providerTimeoutMs = 90_000
): Promise<ToolResult> {
  const buffer = await readFile(filePath);
  const dimensions = readImageDimensions(buffer, path.extname(filePath).toLowerCase());
  const metadata = [
    `image: ${path.basename(filePath)}`,
    `type: ${path.extname(filePath).toLowerCase().replace(".", "") || "unknown"}`,
    `size: ${buffer.length} bytes`,
    dimensions ? `dimensions: ${dimensions.width}x${dimensions.height}` : "dimensions: unknown"
  ];

  if (documentAnalyzer) {
    try {
      const analysis = await runDocumentAnalyzer(documentAnalyzer, {
        path: filePath,
        prompt: "Analyze this image for PatchPilot. Extract all visible text exactly when possible, then describe the important visual elements, layout, UI state, and any errors or warnings.",
        signal
      }, providerTimeoutMs);
      return {
        ok: true,
        summary: `analyzed image ${path.basename(filePath)} with provider file input`,
        content: [...metadata, "", "provider_analysis:", clip(analysis, 20_000)].join("\n"),
        tool: "inspect_document",
        category: toolSpecs.inspect_document.category
      };
    } catch (error) {
      metadata.push("", `provider_analysis_error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (mode === "ocr" || mode === "local") {
    const ocrText = await extractImageTextWithTesseract(filePath, signal);
    if (ocrText) {
      metadata.push("", "ocr_text:", clip(ocrText, 20_000));
    }
  }

  if (documentAnalyzer && mode === "auto") {
    metadata.push("", "analysis_status: metadata_only");
    return {
      ok: false,
      summary: `image analysis failed for ${path.basename(filePath)}; only metadata was available`,
      content: metadata.join("\n"),
      tool: "inspect_document",
      category: toolSpecs.inspect_document.category,
      metadata: {
        analysisStatus: "metadata_only"
      }
    };
  }

  return {
    ok: true,
    summary: `inspected image ${path.basename(filePath)}`,
    content: metadata.join("\n"),
    tool: "inspect_document",
    category: toolSpecs.inspect_document.category
  };
}

async function runDocumentAnalyzer(
  documentAnalyzer: DocumentAnalyzer,
  request: { path: string; prompt: string; signal?: AbortSignal },
  timeoutMs = 180_000
): Promise<string> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<string>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error(`provider file analysis timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
  });
  request.signal?.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([
      documentAnalyzer({
        ...request,
        signal: controller.signal
      }),
      timeoutPromise
    ]);
  } catch (error) {
    if (controller.signal.aborted && !request.signal?.aborted) {
      throw new Error(`provider file analysis timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    request.signal?.removeEventListener("abort", abort);
  }
}

function readImageDimensions(buffer: Buffer, extension: string): { width: number; height: number } | null {
  if (extension === ".png" && buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20)
    };
  }

  if ((extension === ".jpg" || extension === ".jpeg") && buffer.length >= 4) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        return null;
      }
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xc3) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7)
        };
      }
      offset += 2 + length;
    }
  }

  if (extension === ".webp" && buffer.length >= 30 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    const chunk = buffer.subarray(12, 16).toString("ascii");
    if (chunk === "VP8X") {
      return {
        width: 1 + buffer.readUIntLE(24, 3),
        height: 1 + buffer.readUIntLE(27, 3)
      };
    }
  }

  return null;
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

async function extractImageTextWithTesseract(filePath: string, signal?: AbortSignal): Promise<string | null> {
  let cleanupDir = "";
  let inputPath = filePath;
  try {
    const extension = path.extname(filePath).toLowerCase();
    if (extension === ".heic" || extension === ".heif") {
      cleanupDir = await mkdtemp(path.join(tmpdir(), "patchpilot-ocr-"));
      inputPath = path.join(cleanupDir, "image.png");
      await execFileAsync("sips", ["-s", "format", "png", filePath, "--out", inputPath], {
        timeout: 60_000,
        signal,
        windowsHide: true
      });
    }

    const { stdout } = await execFileAsync("tesseract", [inputPath, "stdout", "-l", "eng+deu"], {
      timeout: 90_000,
      maxBuffer: 2_000_000,
      signal,
      windowsHide: true
    });
    const text = stdout.trim();
    return text || null;
  } catch {
    return null;
  } finally {
    if (cleanupDir) {
      await rm(cleanupDir, { recursive: true, force: true });
    }
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

async function extractLegacyDocText(filePath: string, timeoutMs: number, signal?: AbortSignal): Promise<ToolResult> {
  try {
    const { stdout } = await execFileAsync("textutil", ["-convert", "txt", "-stdout", filePath], {
      timeout: timeoutMs,
      signal,
      maxBuffer: 2_000_000
    });
    return {
      ok: true,
      summary: `extracted text from ${path.basename(filePath)}`,
      content: clip(stdout || "No extractable DOC text found.", 20_000)
    };
  } catch (error) {
    return denied(`DOC text extraction needs macOS textutil and a valid .doc file. ${error instanceof Error ? error.message : String(error)}`);
  }
}

function createSimplePdf(content: string, title: string): Buffer {
  const lines = wrapPdfText(`${title ? `${title}\n\n` : ""}${content}`, 92).slice(0, 44);
  const escapedLines = lines.map((line) => `(${escapePdfString(line)}) Tj`).join("\n0 -14 Td\n");
  const stream = `BT\n/F1 11 Tf\n50 780 Td\n14 TL\n${escapedLines}\nET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream`
  ];
  const chunks: string[] = ["%PDF-1.4\n"];
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(chunks.join(""), "utf8"));
    chunks.push(`${index + 1} 0 obj\n${object}\nendobj\n`);
  }
  const xrefOffset = Buffer.byteLength(chunks.join(""), "utf8");
  chunks.push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  for (const offset of offsets.slice(1)) {
    chunks.push(`${offset.toString().padStart(10, "0")} 00000 n \n`);
  }
  chunks.push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return Buffer.from(chunks.join(""), "utf8");
}

function wrapPdfText(value: string, width: number): string[] {
  const lines: string[] = [];
  for (const rawLine of value.replace(/\r\n?/g, "\n").split("\n")) {
    let line = rawLine.trimEnd();
    while (line.length > width) {
      const breakAt = Math.max(line.lastIndexOf(" ", width), 1);
      lines.push(line.slice(0, breakAt).trimEnd());
      line = line.slice(breakAt).trimStart();
    }
    lines.push(line);
  }
  return lines;
}

function escapePdfString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

function createSimpleDocx(content: string, title: string): Buffer {
  const paragraphs = `${title ? `${title}\n\n` : ""}${content}`
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs
    .map((paragraph) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(paragraph)}</w:t></w:r></w:p>`)
    .join("")}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;

  return createZip([
    {
      name: "[Content_Types].xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`
    },
    {
      name: "_rels/.rels",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
    },
    {
      name: "word/document.xml",
      content: documentXml
    }
  ]);
}

function createZip(entries: Array<{ name: string; content: string }>): Buffer {
  const localRecords: Buffer[] = [];
  const centralRecords: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const content = Buffer.from(entry.content, "utf8");
    const compressed = deflateRawSync(content);
    const crc = crc32(content);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    const localRecord = Buffer.concat([localHeader, name, compressed]);
    localRecords.push(localRecord);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    centralRecords.push(Buffer.concat([centralHeader, name]));
    offset += localRecord.length;
  }

  const centralDirectory = Buffer.concat(centralRecords);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(entries.length, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(offset, 16);
  return Buffer.concat([...localRecords, centralDirectory, endRecord]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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

/**
 * A workspace-relative path for display.
 *
 * The root as configured and the path as resolved can differ by a symlink —
 * on macOS /tmp is /private/tmp — which produces a relative path of a dozen
 * "../" segments for a file that is plainly inside the workspace. Resolving
 * both ends through realpath before giving up keeps the display honest.
 */
function normalizeRelative(root: string, filePath: string): string {
  const direct = path.relative(root, filePath);
  if (!direct.startsWith("..")) {
    return direct.split(path.sep).join("/");
  }

  try {
    const resolved = path.relative(realpathSync(root), realpathSync(filePath));
    if (!resolved.startsWith("..")) {
      return resolved.split(path.sep).join("/");
    }
  } catch {
    // Fall through: a path that cannot be resolved is shown as-is.
  }

  return direct.split(path.sep).join("/");
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
  const changedFiles = extractPatchTargetPaths(patchContent);
  const uniqueFiles = [...new Set(changedFiles)].slice(0, 6);
  const fileSummary = uniqueFiles.length > 0 ? uniqueFiles.join(", ") : "unknown files";
  const added = patchContent.split(/\r?\n/).filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
  const removed = patchContent.split(/\r?\n/).filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
  return `Apply patch to ${fileSummary} (+${added}/-${removed}).`;
}

function extractPatchTargetPaths(patchContent: string): string[] {
  const paths: string[] = [];
  for (const line of patchContent.split(/\r?\n/)) {
    if (!line.startsWith("+++ ") && !line.startsWith("--- ")) {
      continue;
    }

    const rawPath = normalizePatchHeaderPath(line.slice(4));
    const normalizedPath = rawPath.replace(/^a\//, "").replace(/^b\//, "");
    if (normalizedPath && normalizedPath !== "/dev/null") {
      paths.push(normalizedPath);
    }
  }

  return [...new Set(paths)];
}

function patchCreatesSymlink(patchContent: string): boolean {
  return /^new file mode 120000$/m.test(patchContent) || /^new mode 120000$/m.test(patchContent);
}

function normalizePatchHeaderPath(value: string): string {
  const trimmedValue = value.trim();
  if (!trimmedValue || trimmedValue === "/dev/null") {
    return trimmedValue;
  }

  if (trimmedValue.startsWith("\"")) {
    try {
      return JSON.parse(trimmedValue) as string;
    } catch {
      return trimmedValue.slice(1).split("\"")[0] ?? trimmedValue;
    }
  }

  return trimmedValue;
}

function validateShellCommand(command: string, workspaceRoot: string, options: { allowMetacharacters: boolean }): { error: string | null; requiresApprovalReason?: string } {
  const trimmedCommand = command.trim();
  const syntax = analyzeShellSyntax(trimmedCommand);
  if (!options.allowMetacharacters) {
    if (syntax.hasShellChains || syntax.highRiskReasons.length > 0) {
      return {
        error:
          "shell metacharacters beyond pipes require /experimental shell-metacharacters; redirects, expansion, background jobs, OR chains, and multiline commands stay approval-gated."
      };
    }
  }

  const tokens = syntax.tokens;
  if (tokens.length === 0) {
    return { error: "command is empty." };
  }

  for (const segment of splitShellCommandSegments(tokens)) {
    const segmentError = validateShellSegment(segment);
    if (segmentError) {
      return { error: segmentError };
    }
  }

  for (const token of tokens.filter((value) => !shellOperatorTokens.has(value))) {
    const normalizedToken = stripQuotes(token);
    if (isSensitivePath(normalizedToken)) {
      return { error: "sensitive path arguments are blocked." };
    }

    if (/(^|[\\/])\.\.([\\/]|$)/.test(normalizedToken)) {
      return { error: "parent directory traversal is blocked." };
    }

    const absolutePath = toAbsoluteShellPath(normalizedToken);
    if (absolutePath) {
      const relativePath = path.relative(workspaceRoot, absolutePath);
      if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
        return { error: "absolute path arguments outside the workspace are blocked. Use inspect_document with /experimental file-analysis for external files." };
      }
    }
  }

  return {
    error: null,
    requiresApprovalReason: syntax.highRiskReasons[0]
  };
}

type PackageScriptCommand = {
  name: string;
  command: string;
};

function collectPackageScriptCommands(scripts: Record<string, string>, scriptName: string): PackageScriptCommand[] {
  return [`pre${scriptName}`, scriptName, `post${scriptName}`]
    .filter((name) => typeof scripts[name] === "string")
    .map((name) => ({
      name,
      command: scripts[name] ?? ""
    }));
}

function validatePackageScriptCommands(commands: PackageScriptCommand[], workspaceRoot: string): string | null {
  for (const entry of commands) {
    const error = validatePackageScriptCommand(entry.command, workspaceRoot);
    if (error) {
      return `${entry.name}: ${error}`;
    }
  }

  return null;
}

function validatePackageScriptCommand(command: string, workspaceRoot: string): string | null {
  const trimmedCommand = command.trim();
  if (!trimmedCommand) {
    return "package script is empty.";
  }

  if (/[;<>`$\n\r]/.test(trimmedCommand)) {
    return "dangerous shell metacharacters are blocked in package scripts before approval.";
  }

  if (/(^|\s)&($|\s)/.test(trimmedCommand)) {
    return "background shell execution is blocked in package scripts.";
  }

  const tokens = tokenizeShellCommand(trimmedCommand);
  for (const commandTokens of splitPackageCommandTokens(tokens)) {
    for (const segment of splitPipeline(commandTokens)) {
      const segmentError = validatePackageScriptSegment(segment);
      if (segmentError) {
        return segmentError;
      }
    }
  }

  for (const token of tokens.filter((value) => value !== "|" && value !== "&&" && value !== "||")) {
    const normalizedToken = stripQuotes(token);
    if (isSensitivePath(normalizedToken)) {
      return "sensitive path arguments are blocked.";
    }

    if (/(^|[\\/])\.\.([\\/]|$)/.test(normalizedToken)) {
      return "parent directory traversal is blocked.";
    }

    const absolutePath = toAbsoluteShellPath(normalizedToken);
    if (absolutePath) {
      const relativePath = path.relative(workspaceRoot, absolutePath);
      if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
        return "absolute path arguments outside the workspace are blocked.";
      }
    }
  }

  return null;
}

function splitPackageCommandTokens(tokens: string[]): string[][] {
  const commands: string[][] = [[]];
  for (const token of tokens) {
    if (token === "&&" || token === "||") {
      commands.push([]);
      continue;
    }

    commands.at(-1)?.push(token);
  }

  return commands;
}

const shellOperatorTokens = new Set(["|", "&&", "||", ";", "&", "<", "<<", ">", ">>"]);

function analyzeShellSyntax(command: string): { tokens: string[]; hasShellChains: boolean; highRiskReasons: string[] } {
  const tokens: string[] = [];
  const highRiskReasons = new Set<string>();
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaping = false;
  let hasShellChains = false;

  const pushCurrent = () => {
    if (current) {
      tokens.push(current);
      current = "";
    }
  };
  const pushOperator = (operator: string) => {
    pushCurrent();
    tokens.push(operator);
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    const next = command[index + 1] ?? "";

    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      current += char;
      escaping = true;
      continue;
    }

    if (quote) {
      current += char;
      if (quote === "\"" && (char === "$" || char === "`")) {
        highRiskReasons.add("shell expansion");
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === "\"") {
      current += char;
      quote = char;
      continue;
    }

    if (char === "\n" || char === "\r") {
      pushCurrent();
      highRiskReasons.add("multiline command");
      continue;
    }

    if (/\s/.test(char)) {
      pushCurrent();
      continue;
    }

    if (char === "|") {
      if (next === "|") {
        pushOperator("||");
        highRiskReasons.add("OR chain");
        index += 1;
      } else {
        pushOperator("|");
      }
      continue;
    }

    if (char === "&") {
      if (next === "&") {
        pushOperator("&&");
        hasShellChains = true;
        index += 1;
      } else {
        pushOperator("&");
        highRiskReasons.add("background execution");
      }
      continue;
    }

    if (char === ";") {
      pushOperator(";");
      hasShellChains = true;
      continue;
    }

    if (char === "<" || char === ">") {
      const operator = next === char ? `${char}${next}` : char;
      pushOperator(operator);
      highRiskReasons.add("redirection");
      if (next === char) {
        index += 1;
      }
      continue;
    }

    if (char === "$" || char === "`") {
      highRiskReasons.add("shell expansion");
    }

    if (char === "*" || char === "?" || char === "[") {
      highRiskReasons.add("glob expansion");
    }

    current += char;
  }

  pushCurrent();

  return {
    tokens,
    hasShellChains,
    highRiskReasons: [...highRiskReasons]
  };
}

function tokenizeShellCommand(command: string): string[] {
  return analyzeShellSyntax(command).tokens;
}

function validatePackageScriptSegment(tokens: string[]): string | null {
  if (tokens.length === 0) {
    return "empty shell pipeline segment.";
  }

  const executable = stripQuotes(tokens[0] ?? "").toLowerCase();
  const subcommand = findCommandSubcommand(executable, tokens.slice(1));
  if (["bash", "sh", "zsh", "fish", "pwsh", "powershell", "powershell.exe"].includes(executable)) {
    return `executable "${executable}" is blocked in package scripts.`;
  }

  if (["rm", "rmdir", "mv", "cp"].includes(executable) && tokens.some((token) => /^-.*[fRr]/.test(stripQuotes(token)))) {
    return `destructive ${executable} flags are blocked.`;
  }

  if (executable === "git" && subcommand && ["clean", "reset", "push", "checkout", "switch", "branch", "tag"].includes(subcommand)) {
    return `git ${subcommand} is blocked in package scripts.`;
  }

  if (executable === "npm" && subcommand && ["publish", "unpublish", "dist-tag"].includes(subcommand)) {
    return `npm ${subcommand} is blocked in package scripts.`;
  }

  return null;
}

function validateShellSegment(tokens: string[]): string | null {
  if (tokens.length === 0) {
    return "empty shell pipeline segment.";
  }

  const executable = stripQuotes(tokens[0] ?? "").toLowerCase();
  const subcommand = findCommandSubcommand(executable, tokens.slice(1));
  if (["bash", "sh", "zsh", "fish", "pwsh", "powershell", "powershell.exe", "python", "python3", "node", "ruby", "perl"].includes(executable)) {
    return `executable "${executable}" is blocked.`;
  }

  if (["rm", "rmdir", "mv", "cp"].includes(executable) && tokens.some((token) => /^-.*[fRr]/.test(stripQuotes(token)))) {
    return `destructive ${executable} flags are blocked.`;
  }

  if (executable === "git" && subcommand && ["clean", "reset", "push", "checkout", "switch", "branch", "tag"].includes(subcommand)) {
    return `git ${subcommand} is blocked in the shell tool.`;
  }

  if (executable === "npm" && subcommand && ["publish", "unpublish", "dist-tag"].includes(subcommand)) {
    return `npm ${subcommand} is blocked in the shell tool.`;
  }

  return null;
}

function splitShellCommandSegments(tokens: string[]): string[][] {
  const segments: string[][] = [[]];
  for (const token of tokens) {
    if (["|", "&&", "||", ";", "&"].includes(token)) {
      segments.push([]);
      continue;
    }

    segments.at(-1)?.push(token);
  }

  return segments;
}

function splitPipeline(tokens: string[]): string[][] {
  const segments: string[][] = [[]];
  for (const token of tokens) {
    if (token === "|") {
      segments.push([]);
      continue;
    }

    segments.at(-1)?.push(token);
  }

  return segments;
}

function findCommandSubcommand(executable: string, tokens: string[]): string | null {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = stripQuotes(tokens[index] ?? "");
    if (!token || token === "--") {
      continue;
    }

    if (executable === "git" && ["-C", "-c", "--git-dir", "--work-tree"].includes(token)) {
      index += 1;
      continue;
    }

    if (executable === "npm" && ["--prefix", "--userconfig", "--cache"].includes(token)) {
      index += 1;
      continue;
    }

    if (token.startsWith("-")) {
      continue;
    }

    return token.toLowerCase();
  }

  return null;
}

function toAbsoluteShellPath(value: string): string | null {
  if (!value || value === "|" || value.startsWith("-")) {
    return null;
  }

  if (path.isAbsolute(value)) {
    return path.resolve(value);
  }

  if (value === "~" || value.startsWith("~/")) {
    return path.resolve(homedir(), value === "~" ? "." : value.slice(2));
  }

  return null;
}

function previewPackageScriptSequence(name: string, commands: PackageScriptCommand[], workspaceRoot: string): string {
  const commandSummary = commands.map((entry) => `${entry.name}: ${entry.command}`).join(" && ");
  const risk = validatePackageScriptCommands(commands, workspaceRoot);
  const prefix = risk ? `Risky package script (${risk})` : "Run package script";
  return `${prefix}: npm run ${name} -> ${clip(commandSummary, 220)}`;
}

function approvalScopeKey(tool: AgentToolName, permission: Exclude<ToolPermission, "none">, args: Record<string, unknown>): string {
  const target = approvalScopeTarget(tool, args);
  return `${permission}:${tool}:${target}`;
}

function approvalScopeTarget(tool: AgentToolName, args: Record<string, unknown>): string {
  switch (tool) {
    case "write_file":
    case "edit_file":
    case "create_pdf":
    case "create_docx":
      return `path:${normalizeScopeValue(readString(args.path, ""))}`;
    case "apply_patch":
      return `patch:${readString(args.patchHash, "") || stableHash(readString(args.patch, ""))}`;
    case "run_script":
    case "run_tests": {
      const script = normalizeScopeValue(readString(args.script, tool === "run_tests" ? "test" : ""));
      const command = normalizeCommandForScope(readString(args.command, ""));
      return `script:${script}:${stableHash(command)}`;
    }
    case "run_shell":
      return `command:${stableHash(normalizeCommandForScope(readString(args.command, "")))}`;
    case "inspect_document":
      return `external:${normalizeScopeValue(readString(args.path, ""))}`;
    case "memory_remember":
      return `memory:${stableHash(readString(args.content, ""))}`;
    default:
      return stableHash(JSON.stringify(args));
  }
}

function normalizeScopeValue(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/\/+/g, "/").replace(/^\.\//, "") || ".";
}

function normalizeCommandForScope(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function readStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, "");
}
