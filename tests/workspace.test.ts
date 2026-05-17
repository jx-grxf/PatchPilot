import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { deflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceTools } from "../src/core/workspace.js";

const execFileAsync = promisify(execFile);

let tempRoot = "";

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), "patchpilot-"));
});

afterEach(async () => {
  await rm(tempRoot, {
    recursive: true,
    force: true
  });
});

describe("WorkspaceTools", () => {
  it("rejects paths outside the workspace", () => {
    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: false,
      allowShell: false
    });

    expect(() => tools.resolveInsideWorkspace("../outside.txt")).toThrow(/escapes workspace/);
  });

  it("lists workspace files", async () => {
    await mkdir(path.join(tempRoot, "src"));
    await writeFile(path.join(tempRoot, "src", "index.ts"), "export const ok = true;\n");

    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: false,
      allowShell: false
    });

    const result = await tools.execute({
      name: "list_files",
      arguments: {
        path: "."
      }
    });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("src/index.ts");
  });

  it("treats workspace-prefixed paths as relative to the root", async () => {
    const workspaceName = path.basename(tempRoot);
    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: true,
      allowShell: false
    });

    const result = await tools.execute({
      name: "write_file",
      arguments: {
        path: `${workspaceName}/test2/test.txt`,
        content: "hallo"
      }
    });

    expect(result.ok).toBe(true);
    await expect(readFile(path.join(tempRoot, "test2", "test.txt"), "utf8")).resolves.toBe("hallo");
  });

  it("denies writes unless enabled", async () => {
    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: false,
      allowShell: false
    });

    const result = await tools.execute({
      name: "write_file",
      arguments: {
        path: "note.txt",
        content: "hello"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("--apply");
  });

  it("validates write paths before requesting approval", async () => {
    let approvals = 0;
    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: false,
      allowShell: false,
      approvalHandler: async () => {
        approvals += 1;
        return "allow_once";
      }
    });

    const result = await tools.execute({
      name: "write_file",
      arguments: {
        path: "relative/path",
        content: "hello"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("placeholder");
    expect(approvals).toBe(0);
  });

  it("rejects placeholder read paths", async () => {
    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: false,
      allowShell: false
    });

    const result = await tools.execute({
      name: "read_file",
      arguments: {
        path: "relative/path"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("placeholder");
  });

  it("falls back to inspect_document for text files", async () => {
    await writeFile(path.join(tempRoot, "note.txt"), "hello\n");
    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: false,
      allowShell: false
    });

    const result = await tools.execute({
      name: "inspect_document",
      arguments: {
        path: "note.txt"
      }
    });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("hello");
  });

  it("extracts text from docx files without external unzip tools", async () => {
    const docxPath = path.join(tempRoot, "sample.docx");
    await writeFile(docxPath, createMinimalDocx("Hallo aus DOCX"));
    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: false,
      allowShell: false
    });

    const result = await tools.execute({
      name: "inspect_document",
      arguments: {
        path: "sample.docx"
      }
    });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Hallo aus DOCX");
  });

  it("rejects unknown tool calls with an explicit error", async () => {
    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: false,
      allowShell: false
    });

    const result = await tools.execute({
      name: "unknown_tool",
      arguments: {}
    } as never);

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("unknown tool");
  });

  it("lists package scripts without enabling shell", async () => {
    await writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({
        scripts: {
          test: "vitest run",
          build: "tsc"
        }
      })
    );
    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: false,
      allowShell: false
    });

    const result = await tools.execute({
      name: "list_scripts",
      arguments: {}
    });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("build: tsc");
    expect(result.content).toContain("test: vitest run");
  });

  it("reads git status without enabling shell", async () => {
    await execFileAsync("git", ["init"], {
      cwd: tempRoot
    });
    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: false,
      allowShell: false
    });

    const result = await tools.execute({
      name: "git_status",
      arguments: {}
    });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("##");
  });

  it("reads a bounded line range", async () => {
    await writeFile(path.join(tempRoot, "note.txt"), "one\ntwo\nthree\n");
    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: false,
      allowShell: false
    });

    const result = await tools.execute({
      name: "read_range",
      arguments: {
        path: "note.txt",
        start: 2,
        end: 3
      }
    });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("2: two");
    expect(result.content).toContain("3: three");
  });

  it("reads git diff and changed files", async () => {
    await execFileAsync("git", ["init"], {
      cwd: tempRoot
    });
    await writeFile(path.join(tempRoot, "note.txt"), "one\n");
    await execFileAsync("git", ["add", "note.txt"], {
      cwd: tempRoot
    });
    await execFileAsync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "init"], {
      cwd: tempRoot,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "PatchPilot",
        GIT_AUTHOR_EMAIL: "patchpilot@example.com",
        GIT_COMMITTER_NAME: "PatchPilot",
        GIT_COMMITTER_EMAIL: "patchpilot@example.com"
      }
    });
    await writeFile(path.join(tempRoot, "note.txt"), "one\ntwo\n");

    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: false,
      allowShell: false
    });

    const diff = await tools.execute({
      name: "git_diff",
      arguments: {}
    });
    expect(diff.ok).toBe(true);
    expect(diff.content).toContain("+two");

    const files = await tools.execute({
      name: "list_changed_files",
      arguments: {}
    });
    expect(files.content).toContain("note.txt");
  });

  it("applies unified patches when writes are enabled", async () => {
    await execFileAsync("git", ["init"], {
      cwd: tempRoot
    });
    await writeFile(path.join(tempRoot, "note.txt"), "one\n");
    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: true,
      allowShell: false
    });

    const result = await tools.execute({
      name: "apply_patch",
      arguments: {
        patch: ["diff --git a/note.txt b/note.txt", "index 5626abf..814f4a4 100644", "--- a/note.txt", "+++ b/note.txt", "@@ -1 +1,2 @@", " one", "+two", ""].join("\n")
      }
    });

    expect(result.ok).toBe(true);
    await expect(readFile(path.join(tempRoot, "note.txt"), "utf8")).resolves.toBe("one\ntwo\n");
  });

  it("requests approval for scripts when shell is not globally enabled", async () => {
    await writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({
        scripts: {
          test: "node -e \"process.exit(0)\""
        }
      })
    );
    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: false,
      allowShell: false,
      approvalHandler: async () => "deny"
    });

    const result = await tools.execute({
      name: "run_tests",
      arguments: {}
    });

    expect(result.ok).toBe(false);
    expect(result.approval?.request.tool).toBe("run_script");
    expect(result.approval?.request.preview).toContain("npm run test");
    expect(result.approval?.request.arguments.command).toContain("node -e");
    expect(result.approval?.decision).toBe("deny");
  });

  it("skips symlinked directories when listing files", async () => {
    const outsideRoot = await mkdtemp(path.join(tmpdir(), "patchpilot-outside-"));
    await mkdir(path.join(tempRoot, "src"));
    await writeFile(path.join(outsideRoot, "secret.txt"), "classified\n");
    await symlink(outsideRoot, path.join(tempRoot, "src", "linked-outside"));

    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: false,
      allowShell: false
    });

    const result = await tools.execute({
      name: "list_files",
      arguments: {
        path: "."
      }
    });

    expect(result.ok).toBe(true);
    expect(result.content).not.toContain("linked-outside");

    await rm(outsideRoot, {
      recursive: true,
      force: true
    });
  });

  it("rejects reading a symlink that points outside the workspace", async () => {
    const outsideRoot = await mkdtemp(path.join(tmpdir(), "patchpilot-outside-"));
    const outsideFile = path.join(outsideRoot, "secret.txt");
    await writeFile(outsideFile, "classified\n");
    await symlink(outsideFile, path.join(tempRoot, "leak.txt"));

    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: false,
      allowShell: false
    });

    const result = await tools.execute({
      name: "read_file",
      arguments: {
        path: "leak.txt"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("escapes workspace");

    await rm(outsideRoot, {
      recursive: true,
      force: true
    });
  });

  it("does not expose sensitive files through search_text", async () => {
    await mkdir(path.join(tempRoot, "nested"));
    await mkdir(path.join(tempRoot, ".patchpilot", "sessions"), {
      recursive: true
    });
    await writeFile(path.join(tempRoot, ".env"), "GEMINI_API_KEY=secret-root\n");
    await writeFile(path.join(tempRoot, ".npmrc"), "//registry.npmjs.org/:_authToken=secret-npm\n");
    await writeFile(path.join(tempRoot, "nested", ".env.local"), "OPENROUTER_API_KEY=secret-nested\n");
    await writeFile(path.join(tempRoot, ".patchpilot", "sessions", "session.jsonl"), "secret-session\n");
    await writeFile(path.join(tempRoot, "note.txt"), "ordinary secret word\n");

    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: false,
      allowShell: false
    });

    const result = await tools.execute({
      name: "search_text",
      arguments: {
        query: "secret"
      }
    });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("note.txt");
    expect(result.content).not.toContain("secret-root");
    expect(result.content).not.toContain("secret-npm");
    expect(result.content).not.toContain("secret-nested");
    expect(result.content).not.toContain("secret-session");
  });

  it("blocks destructive simple shell commands even when shell is enabled", async () => {
    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: true,
      allowShell: true
    });

    const rmResult = await tools.execute({
      name: "run_shell",
      arguments: {
        command: "rm -rf src"
      }
    });
    expect(rmResult.ok).toBe(false);
    expect(rmResult.summary).toContain("destructive rm");

    const gitResult = await tools.execute({
      name: "run_shell",
      arguments: {
        command: "git clean"
      }
    });
    expect(gitResult.ok).toBe(false);
    expect(gitResult.summary).toContain("git clean");
  });

  it("validates shell commands before requesting approval", async () => {
    let approvals = 0;
    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: false,
      allowShell: false,
      approvalHandler: async () => {
        approvals += 1;
        return "allow_once";
      }
    });

    const result = await tools.execute({
      name: "run_shell",
      arguments: {
        command: "rm -rf src"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("destructive rm");
    expect(approvals).toBe(0);
  });

  it("rejects writing through a symlinked directory outside the workspace", async () => {
    const outsideRoot = await mkdtemp(path.join(tmpdir(), "patchpilot-outside-"));
    await mkdir(path.join(tempRoot, "safe"));
    await symlink(outsideRoot, path.join(tempRoot, "safe", "linked-outside"));

    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: true,
      allowShell: false
    });

    const result = await tools.execute({
      name: "write_file",
      arguments: {
        path: "safe/linked-outside/secret.txt",
        content: "nope"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("escapes workspace");
    await expect(readFile(path.join(outsideRoot, "secret.txt"), "utf8")).rejects.toThrow();

    await rm(outsideRoot, {
      recursive: true,
      force: true
    });
  });
});

function createMinimalDocx(text: string): Buffer {
  const fileName = "word/document.xml";
  const xml = `<w:document><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`;
  const fileNameBuffer = Buffer.from(fileName);
  const compressedData = deflateRawSync(Buffer.from(xml));
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(8, 8);
  localHeader.writeUInt32LE(compressedData.length, 18);
  localHeader.writeUInt32LE(Buffer.byteLength(xml), 22);
  localHeader.writeUInt16LE(fileNameBuffer.length, 26);

  const localRecord = Buffer.concat([localHeader, fileNameBuffer, compressedData]);
  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(8, 10);
  centralHeader.writeUInt32LE(compressedData.length, 20);
  centralHeader.writeUInt32LE(Buffer.byteLength(xml), 24);
  centralHeader.writeUInt16LE(fileNameBuffer.length, 28);

  const centralRecord = Buffer.concat([centralHeader, fileNameBuffer]);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(1, 8);
  endRecord.writeUInt16LE(1, 10);
  endRecord.writeUInt32LE(centralRecord.length, 12);
  endRecord.writeUInt32LE(localRecord.length, 16);

  return Buffer.concat([localRecord, centralRecord, endRecord]);
}
