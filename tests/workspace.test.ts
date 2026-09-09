import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { deflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("finds workspace files by path substring without exposing ignored sensitive paths", async () => {
    await mkdir(path.join(tempRoot, "src", "core"), { recursive: true });
    await mkdir(path.join(tempRoot, ".patchpilot", "sessions"), { recursive: true });
    await writeFile(path.join(tempRoot, "src", "core", "agent.ts"), "export const ok = true;\n");
    await writeFile(path.join(tempRoot, ".patchpilot", "sessions", "agent-secret.jsonl"), "secret\n");
    await writeFile(path.join(tempRoot, ".env"), "AGENT_TOKEN=secret\n");
    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: false,
      allowShell: false
    });

    const result = await tools.execute({
      name: "find_files",
      arguments: {
        query: "agent",
        limit: 10
      }
    });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("src/core/agent.ts");
    expect(result.content).not.toContain(".patchpilot");
    expect(result.content).not.toContain(".env");
  });

  it("rejects sensitive file search queries", async () => {
    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: false,
      allowShell: false
    });

    const result = await tools.execute({
      name: "find_files",
      arguments: {
        query: ".env"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("sensitive");
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

  it("normalizes escaped multiline source content before writing", async () => {
    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: true,
      allowShell: false
    });

    const result = await tools.execute({
      name: "write_file",
      arguments: {
        path: "index.html",
        content: '<!DOCTYPE html>\\n<html lang=\\"en\\">\\n<body>\\n  <h1>Snake</h1>\\n</body>\\n</html>'
      }
    });

    expect(result.ok).toBe(true);
    expect(result.metadata?.normalizedEscapedContent).toBe(true);
    await expect(readFile(path.join(tempRoot, "index.html"), "utf8")).resolves.toBe('<!DOCTYPE html>\n<html lang="en">\n<body>\n  <h1>Snake</h1>\n</body>\n</html>');
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

  it("edits an existing file with a unique find and replace", async () => {
    await writeFile(path.join(tempRoot, "index.html"), "<h1>Old title</h1>\n<p>body</p>\n");
    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: true,
      allowShell: false
    });

    const result = await tools.execute({
      name: "edit_file",
      arguments: {
        path: "index.html",
        find: "<h1>Old title</h1>",
        replace: "<h1>New title</h1>"
      }
    });

    expect(result.ok).toBe(true);
    await expect(readFile(path.join(tempRoot, "index.html"), "utf8")).resolves.toBe("<h1>New title</h1>\n<p>body</p>\n");
  });

  it("edits an existing file by line range", async () => {
    await writeFile(path.join(tempRoot, "style.css"), "body {\n  color: black;\n  margin: 0;\n}\n");
    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: true,
      allowShell: false
    });

    const result = await tools.execute({
      name: "edit_file",
      arguments: {
        path: "style.css",
        startLine: 2,
        endLine: 3,
        replacement: "  color: white;\n  background: navy;"
      }
    });

    expect(result.ok).toBe(true);
    await expect(readFile(path.join(tempRoot, "style.css"), "utf8")).resolves.toBe("body {\n  color: white;\n  background: navy;\n}\n");
  });

  it("edits a line range when the expected guard matches", async () => {
    await writeFile(path.join(tempRoot, "style.css"), "body {\n  color: black;\n  margin: 0;\n}\n");
    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: true,
      allowShell: false
    });

    const result = await tools.execute({
      name: "edit_file",
      arguments: {
        path: "style.css",
        startLine: 2,
        endLine: 3,
        expected: "  color: black;\n  margin: 0;",
        replacement: "  color: white;\n  background: navy;"
      }
    });

    expect(result.ok).toBe(true);
    await expect(readFile(path.join(tempRoot, "style.css"), "utf8")).resolves.toBe("body {\n  color: white;\n  background: navy;\n}\n");
  });

  it("rejects stale line range edits when the expected guard does not match", async () => {
    await writeFile(path.join(tempRoot, "style.css"), "body {\n  color: black;\n  margin: 0;\n}\n");
    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: true,
      allowShell: false
    });

    const result = await tools.execute({
      name: "edit_file",
      arguments: {
        path: "style.css",
        startLine: 2,
        endLine: 3,
        expected: "  color: red;\n  margin: 0;",
        replacement: "  color: white;\n  background: navy;"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("expected content");
    await expect(readFile(path.join(tempRoot, "style.css"), "utf8")).resolves.toBe("body {\n  color: black;\n  margin: 0;\n}\n");
  });

  it("normalizes escaped multiline line-range replacements", async () => {
    await writeFile(path.join(tempRoot, "script.js"), "function run() {\n  return false;\n}\n");
    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: true,
      allowShell: false
    });

    const result = await tools.execute({
      name: "edit_file",
      arguments: {
        path: "script.js",
        startLine: 2,
        endLine: 2,
        replacement: '  const label = \\"ok\\";\\n  return label === \\"ok\\";'
      }
    });

    expect(result.ok).toBe(true);
    await expect(readFile(path.join(tempRoot, "script.js"), "utf8")).resolves.toBe('function run() {\n  const label = "ok";\n  return label === "ok";\n}\n');
  });

  it("returns text formatting metadata when reading files", async () => {
    await writeFile(path.join(tempRoot, "broken.html"), '<html>\\n<body>\\n</body>');
    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: false,
      allowShell: false
    });

    const result = await tools.execute({
      name: "read_file",
      arguments: {
        path: "broken.html"
      }
    });

    expect(result.ok).toBe(true);
    expect(result.metadata).toMatchObject({
      lineCount: 1,
      realNewlines: 0,
      literalBackslashN: 2
    });
  });

  it("rejects ambiguous find and replace edits", async () => {
    await writeFile(path.join(tempRoot, "note.txt"), "same\nsame\n");
    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: true,
      allowShell: false
    });

    const result = await tools.execute({
      name: "edit_file",
      arguments: {
        path: "note.txt",
        find: "same",
        replace: "other"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("exactly once");
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

  it("rejects read symlinks that resolve to sensitive workspace files", async () => {
    await writeFile(path.join(tempRoot, "credentials.json"), "{\"token\":\"secret\"}\n");
    await symlink(path.join(tempRoot, "credentials.json"), path.join(tempRoot, "safe.json"));
    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: false,
      allowShell: false
    });

    const result = await tools.execute({
      name: "read_file",
      arguments: {
        path: "safe.json"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("sensitive");
  });

  it("rejects write symlinks that resolve to sensitive workspace files", async () => {
    await writeFile(path.join(tempRoot, ".npmrc"), "token=secret\n");
    await symlink(path.join(tempRoot, ".npmrc"), path.join(tempRoot, "safe.txt"));
    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: true,
      allowShell: false
    });

    const result = await tools.execute({
      name: "write_file",
      arguments: {
        path: "safe.txt",
        content: "changed"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("sensitive");
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

  it("inspects external images when experimental file analysis is enabled", async () => {
    const outsideRoot = await mkdtemp(path.join(tmpdir(), "patchpilot-image-"));
    const imagePath = path.join(outsideRoot, "sample.png");
    await writeFile(imagePath, Buffer.from("89504e470d0a1a0a0000000d4948445200000002000000030802000000", "hex"));
    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: false,
      allowShell: false,
      allowExternalFileAnalysis: true,
      approvalHandler: async (request) => (request.permission === "external_file" ? "allow_once" : "deny")
    });

    const result = await tools.execute({
      name: "inspect_document",
      arguments: {
        path: imagePath
      }
    });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("dimensions: 2x3");
    await rm(outsideRoot, { recursive: true, force: true });
  });

  it("uses provider file analysis for images when available", async () => {
    const imagePath = path.join(tempRoot, "sample.png");
    await writeFile(imagePath, Buffer.from("89504e470d0a1a0a0000000d4948445200000002000000030802000000", "hex"));
    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: false,
      allowShell: false,
      documentAnalyzer: async (request) => `saw ${path.basename(request.path)} text: Hallo`
    });

    const result = await tools.execute({
      name: "inspect_document",
      arguments: {
        path: "sample.png"
      }
    });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("provider_analysis:");
    expect(result.content).toContain("Hallo");
  });

  it("does not claim image analysis succeeded when provider and OCR fail", async () => {
    const imagePath = path.join(tempRoot, "sample.png");
    await writeFile(imagePath, Buffer.from("89504e470d0a1a0a0000000d4948445200000002000000030802000000", "hex"));
    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: false,
      allowShell: false,
      documentAnalyzer: async () => {
        throw new Error("provider unavailable");
      }
    });

    const result = await tools.execute({
      name: "inspect_document",
      arguments: {
        path: "sample.png"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("only metadata");
    expect(result.content).toContain("provider_analysis_error: provider unavailable");
    expect(result.metadata).toMatchObject({
      analysisStatus: "metadata_only"
    });
  });

  it("hard-times out image providers that ignore abort signals", async () => {
    const imagePath = path.join(tempRoot, "sample.png");
    await writeFile(imagePath, Buffer.from("89504e470d0a1a0a0000000d4948445200000002000000030802000000", "hex"));
    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: false,
      allowShell: false,
      timeoutMs: 25,
      documentAnalyzer: async () => new Promise<string>(() => {})
    });

    const startedAt = Date.now();
    const result = await tools.execute({
      name: "inspect_document",
      arguments: {
        path: "sample.png"
      }
    });

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(result.ok).toBe(false);
    expect(result.content).toContain("provider file analysis timed out");
  });

  it("creates readable PDF and DOCX files", async () => {
    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: true,
      allowShell: false
    });

    const pdf = await tools.execute({
      name: "create_pdf",
      arguments: {
        path: "out/report.pdf",
        title: "Report",
        content: "Hallo PDF"
      }
    });
    const docx = await tools.execute({
      name: "create_docx",
      arguments: {
        path: "out/report.docx",
        title: "Report",
        content: "Hallo DOCX"
      }
    });

    expect(pdf.ok).toBe(true);
    expect(docx.ok).toBe(true);
    await expect(readFile(path.join(tempRoot, "out", "report.pdf"), "utf8")).resolves.toContain("%PDF-1.4");

    const inspect = await tools.execute({
      name: "inspect_document",
      arguments: {
        path: "out/report.docx"
      }
    });
    expect(inspect.ok).toBe(true);
    expect(inspect.content).toContain("Hallo DOCX");
  });

  it("rejects patches that target sensitive workspace files", async () => {
    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: true,
      allowShell: false
    });

    const result = await tools.execute({
      name: "apply_patch",
      arguments: {
        patch: ["diff --git a/.env b/.env", "new file mode 100644", "--- /dev/null", "+++ b/.env", "@@ -0,0 +1 @@", "+TOKEN=secret"].join("\n")
      }
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("sensitive");
  });

  it("rejects patches that create symlinks", async () => {
    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: true,
      allowShell: false
    });

    const result = await tools.execute({
      name: "apply_patch",
      arguments: {
        patch: ["diff --git a/leak.txt b/leak.txt", "new file mode 120000", "index 0000000..c7d76fa", "--- /dev/null", "+++ b/leak.txt", "@@ -0,0 +1 @@", "+/Users/x/.ssh/id_ed25519"].join("\n")
      }
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("symlink");
  });

  it("accepts update_todo as a side-effect-free state tool", async () => {
    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: false,
      allowShell: false
    });

    const result = await tools.execute({
      name: "update_todo",
      arguments: {
        items: [{ id: "inspect", content: "Inspect files", status: "in_progress" }]
      }
    });

    expect(result.ok).toBe(true);
    expect(result.category).toBe("state");
  });

  it("blocks external files when experimental file analysis is disabled", async () => {
    const outsideRoot = await mkdtemp(path.join(tmpdir(), "patchpilot-external-"));
    const filePath = path.join(outsideRoot, "note.md");
    await writeFile(filePath, "# outside\n");
    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: false,
      allowShell: false
    });

    const result = await tools.execute({
      name: "inspect_document",
      arguments: {
        path: filePath
      }
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("file-analysis");
    await rm(outsideRoot, { recursive: true, force: true });
  });

  it("stores and searches workspace memory when experimental memory is enabled", async () => {
    const configRoot = await mkdtemp(path.join(tmpdir(), "patchpilot-memory-config-"));
    const previousConfigDir = process.env.PATCHPILOT_CONFIG_DIR;
    process.env.PATCHPILOT_CONFIG_DIR = configRoot;
    try {
      const tools = new WorkspaceTools({
        root: tempRoot,
        allowWrite: false,
        allowShell: false,
        memoryEnabled: true,
        approvalHandler: async (request) => (request.tool === "memory_remember" ? "allow_once" : "deny")
      });

      const remember = await tools.execute({
        name: "memory_remember",
        arguments: {
          content: "Gemini wrapper should default to auto mode.",
          tags: ["provider"]
        }
      });
      expect(remember.ok).toBe(true);

      const search = await tools.execute({
        name: "memory_search",
        arguments: {
          query: "gemini auto"
        }
      });
      expect(search.ok).toBe(true);
      expect(search.content).toContain("Gemini wrapper");
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.PATCHPILOT_CONFIG_DIR;
      } else {
        process.env.PATCHPILOT_CONFIG_DIR = previousConfigDir;
      }
      await rm(configRoot, { recursive: true, force: true });
    }
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

  it("scopes allow-session approvals to the requested tool", async () => {
    await writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({
        scripts: {
          echo: "node -e \"console.log('ok')\""
        }
      })
    );
    const approvals: string[] = [];
    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: false,
      allowShell: false,
      approvalHandler: async (request) => {
        approvals.push(request.tool);
        return request.tool === "run_script" ? "allow_session" : "deny";
      }
    });

    await expect(tools.execute({ name: "run_script", arguments: { script: "echo" } })).resolves.toMatchObject({
      ok: true
    });
    const shellResult = await tools.execute({ name: "run_shell", arguments: { command: "pwd" } });

    expect(shellResult.ok).toBe(false);
    expect(approvals).toEqual(["run_script", "run_shell"]);
  });

  it("scopes allow-session write approvals to the concrete path", async () => {
    const approvals: string[] = [];
    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: false,
      allowShell: false,
      approvalHandler: async (request) => {
        approvals.push(String(request.arguments.path));
        return request.arguments.path === "a.txt" ? "allow_session" : "deny";
      }
    });

    await expect(tools.execute({ name: "write_file", arguments: { path: "a.txt", content: "one" } })).resolves.toMatchObject({ ok: true });
    await expect(tools.execute({ name: "write_file", arguments: { path: "a.txt", content: "two" } })).resolves.toMatchObject({ ok: true });
    const otherFile = await tools.execute({ name: "write_file", arguments: { path: "b.txt", content: "three" } });

    expect(otherFile.ok).toBe(false);
    expect(approvals).toEqual(["a.txt", "b.txt"]);
  });

  it("scopes allow-session script approvals to the script body", async () => {
    await writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({
        scripts: {
          echo: "node -e \"console.log('ok')\"",
          build: "node -e \"console.log('build')\""
        }
      })
    );
    const approvals: string[] = [];
    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: false,
      allowShell: false,
      approvalHandler: async (request) => {
        approvals.push(`${request.arguments.script}:${request.arguments.command}`);
        return request.arguments.script === "echo" ? "allow_session" : "deny";
      }
    });

    await expect(tools.execute({ name: "run_script", arguments: { script: "echo" } })).resolves.toMatchObject({ ok: true });
    await expect(tools.execute({ name: "run_script", arguments: { script: "echo" } })).resolves.toMatchObject({ ok: true });
    const build = await tools.execute({ name: "run_script", arguments: { script: "build" } });

    expect(build.ok).toBe(false);
    expect(approvals).toEqual([
      "echo:echo: node -e \"console.log('ok')\"",
      "build:build: node -e \"console.log('build')\""
    ]);
  });

  it("blocks dangerous package script content before requesting approval", async () => {
    await writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({
        scripts: {
          bad: "git reset --hard"
        }
      })
    );
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

    const result = await tools.execute({ name: "run_script", arguments: { script: "bad" } });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("before approval");
    expect(approvals).toBe(0);
  });

  it("blocks dangerous npm lifecycle scripts before requesting approval", async () => {
    await writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({
        scripts: {
          pretest: "git reset --hard",
          test: "vitest run"
        }
      })
    );
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

    const result = await tools.execute({ name: "run_tests", arguments: {} });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("pretest");
    expect(result.summary).toContain("before approval");
    expect(approvals).toBe(0);
  });

  it("includes npm lifecycle scripts in approval scope and preview", async () => {
    await writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({
        scripts: {
          prebuild: "node -e \"console.log('pre')\"",
          build: "node -e \"console.log('build')\""
        }
      })
    );
    const approvals: string[] = [];
    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: false,
      allowShell: false,
      approvalHandler: async (request) => {
        approvals.push(String(request.arguments.command));
        return "allow_once";
      }
    });

    const result = await tools.execute({ name: "run_script", arguments: { script: "build" } });

    expect(result.ok).toBe(true);
    expect(result.preview).toContain("prebuild");
    expect(approvals[0]).toContain("prebuild");
    expect(approvals[0]).toContain("build");
  });

  it("rejects patches that target sensitive paths containing spaces", async () => {
    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: true,
      allowShell: false
    });

    const result = await tools.execute({
      name: "apply_patch",
      arguments: {
        patch: [
          "diff --git a/Library/Application Support/Google/Chrome/Default/Login Data b/Library/Application Support/Google/Chrome/Default/Login Data",
          "--- /dev/null",
          "+++ b/Library/Application Support/Google/Chrome/Default/Login Data",
          "@@ -0,0 +1 @@",
          "+secret"
        ].join("\n")
      }
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("sensitive");
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

  it("reads repo overview, git history, tests, and dependencies without enabling shell", async () => {
    await execFileAsync("git", ["init"], {
      cwd: tempRoot
    });
    await writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({
        name: "sample",
        version: "1.0.0",
        scripts: {
          test: "vitest run",
          build: "tsc"
        },
        dependencies: {
          ink: "^7.0.0"
        },
        devDependencies: {
          vitest: "^4.0.0"
        }
      })
    );
    await mkdir(path.join(tempRoot, "tests"));
    await writeFile(path.join(tempRoot, "tests", "sample.test.ts"), "import { it } from 'vitest';\n");
    await execFileAsync("git", ["add", "."], {
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
    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: false,
      allowShell: false
    });

    await expect(tools.execute({ name: "repo_overview", arguments: {} })).resolves.toMatchObject({ ok: true, tool: "repo_overview" });
    await expect(tools.execute({ name: "git_log", arguments: { limit: 1 } })).resolves.toMatchObject({ ok: true, tool: "git_log" });
    await expect(tools.execute({ name: "git_show", arguments: { revision: "HEAD" } })).resolves.toMatchObject({ ok: true, tool: "git_show" });
    const tests = await tools.execute({ name: "test_list", arguments: {} });
    const dependencies = await tools.execute({ name: "dependency_tree", arguments: {} });

    expect(tests.content).toContain("tests/sample.test.ts");
    expect(dependencies.content).toContain("ink@^7.0.0");
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
    expect(result.approval?.request.tool).toBe("run_tests");
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
    await mkdir(path.join(tempRoot, "Library", "Application Support", "Google", "Chrome", "Default", "Network"), {
      recursive: true
    });
    await writeFile(path.join(tempRoot, "Library", "Application Support", "Google", "Chrome", "Default", "Network", "Cookies"), "secret-browser-cookie\n");
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
    expect(result.content).not.toContain("secret-browser-cookie");
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

  it("allows approved shell pipes inside the workspace", async () => {
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
        command: "printf hello | wc -c"
      }
    });

    expect(approvals).toBe(1);
    expect(result.summary).toContain("command exited");
  });

  it("blocks shell chains until experimental shell metacharacters are enabled", async () => {
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
        command: "printf hello && printf world"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("shell metacharacters");
    expect(approvals).toBe(0);
  });

  it("allows approved shell chains when experimental shell metacharacters are enabled", async () => {
    let approvals = 0;
    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: false,
      allowShell: false,
      allowShellMetacharacters: true,
      approvalHandler: async () => {
        approvals += 1;
        return "allow_once";
      }
    });

    const result = await tools.execute({
      name: "run_shell",
      arguments: {
        command: "printf hello && printf world"
      }
    });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("helloworld");
    expect(approvals).toBe(1);
  });

  it("forces approval for high-risk shell syntax even when shell bypass is enabled", async () => {
    let approvals = 0;
    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: true,
      allowShell: true,
      allowShellMetacharacters: true,
      approvalHandler: async () => {
        approvals += 1;
        return "deny";
      }
    });

    const result = await tools.execute({
      name: "run_shell",
      arguments: {
        command: "printf secret > out.txt"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.approval?.request.bypassable).toBe(false);
    expect(result.approval?.request.preview).toContain("redirection");
    expect(approvals).toBe(1);
    await expect(readFile(path.join(tempRoot, "out.txt"), "utf8")).rejects.toThrow();
  });

  it("blocks unapproved shell glob expansion before bypass execution", async () => {
    await writeFile(path.join(tempRoot, "secret.txt"), "secret");
    let approvals = 0;
    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: true,
      allowShell: true,
      allowShellMetacharacters: true,
      approvalHandler: async () => {
        approvals += 1;
        return "deny";
      }
    });

    const result = await tools.execute({
      name: "run_shell",
      arguments: {
        command: "cat *.txt"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.approval?.request.preview).toContain("glob expansion");
    expect(approvals).toBe(1);
  });

  it("blocks absolute shell path arguments outside the workspace before approval", async () => {
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
        command: "cat /etc/shells | head -n 1"
      }
    });

    expect(approvals).toBe(0);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("outside the workspace");
    // The message has to name a next action the model can actually take.
    expect(result.summary).toContain("workspace-relative");
  });

  it("blocks dangerous git and npm subcommands after global options", async () => {
    const tools = new WorkspaceTools({
      root: tempRoot,
      allowWrite: false,
      allowShell: false,
      approvalHandler: async () => "allow_once"
    });

    const gitResult = await tools.execute({
      name: "run_shell",
      arguments: {
        command: "git -C . reset --hard"
      }
    });
    expect(gitResult.ok).toBe(false);
    expect(gitResult.summary).toContain("git reset");

    const npmResult = await tools.execute({
      name: "run_shell",
      arguments: {
        command: "npm --prefix . publish"
      }
    });
    expect(npmResult.ok).toBe(false);
    expect(npmResult.summary).toContain("npm publish");
  });

  it("blocks sensitive shell path arguments before approval", async () => {
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
        command: "cat ~/.npmrc"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("sensitive path");
    expect(approvals).toBe(0);
  });

  it("blocks shell reads through symlinks before approval", async () => {
    const outsideRoot = await mkdtemp(path.join(tmpdir(), "patchpilot-outside-"));
    await writeFile(path.join(outsideRoot, "secret.txt"), "classified\n");
    await symlink(path.join(outsideRoot, "secret.txt"), path.join(tempRoot, "leak.txt"));

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
        command: "cat leak.txt"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("escapes workspace");
    expect(approvals).toBe(0);

    await rm(outsideRoot, {
      recursive: true,
      force: true
    });
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

describe("WorkspaceTools fetch_url", () => {
  let fetchRoot = "";

  beforeEach(async () => {
    fetchRoot = await mkdtemp(path.join(tmpdir(), "patchpilot-fetch-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(fetchRoot, { recursive: true, force: true });
  });

  function fetchTools(
    overrides: { allowShell?: boolean; approvalHandler?: ConstructorParameters<typeof WorkspaceTools>[0]["approvalHandler"] } = {}
  ): WorkspaceTools {
    // Default allowShell:true models build+bypass so the network gate is open.
    return new WorkspaceTools({
      root: fetchRoot,
      allowWrite: false,
      allowShell: overrides.allowShell ?? true,
      approvalHandler: overrides.approvalHandler
    });
  }

  it("rejects non-http(s) schemes", async () => {
    const result = await fetchTools().execute({ name: "fetch_url", arguments: { url: "file:///etc/passwd" } });
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/only allows http/i);
  });

  it("blocks loopback and private hosts before making a request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    for (const url of ["http://127.0.0.1/", "http://localhost/", "http://169.254.169.254/latest/meta-data", "http://192.168.1.1/"]) {
      const result = await fetchTools().execute({ name: "fetch_url", arguments: { url } });
      expect(result.ok, url).toBe(false);
      expect(result.summary, url).toMatch(/blocked/i);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fetches a public URL and converts HTML to readable text", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html><head><style>x{}</style></head><body><h1>Title</h1><p>Hello world</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" }
      })
    );

    // IP literal avoids real DNS resolution while passing the public-host guard.
    const result = await fetchTools().execute({ name: "fetch_url", arguments: { url: "https://93.184.216.34/" } });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Title");
    expect(result.content).toContain("Hello world");
    expect(result.content).not.toContain("<p>");
    expect(result.content).not.toContain("x{}");
  });

  it("caps and cancels large response bodies before decoding all of them", async () => {
    const cancel = vi.fn();
    const oversized = new TextEncoder().encode("x".repeat(300_000));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(oversized);
        },
        cancel
      }), { status: 200, headers: { "content-type": "text/plain" } })
    );

    const result = await fetchTools().execute({ name: "fetch_url", arguments: { url: "https://93.184.216.34/" } });

    expect(result.ok).toBe(true);
    expect(result.metadata).toMatchObject({ bytes: 256_000, truncated: true });
    expect(result.content.length).toBeLessThan(21_000);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("recovers a URL from Markdown link / angle-bracket / bare-domain shapes", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200, headers: { "content-type": "text/plain" } })
    );

    for (const input of [
      "[https://93.184.216.34/](https://93.184.216.34/)",
      "<https://93.184.216.34/>",
      "`https://93.184.216.34/`",
      "93.184.216.34"
    ]) {
      const result = await fetchTools().execute({ name: "fetch_url", arguments: { url: input } });
      expect(result.ok, input).toBe(true);
    }

    for (const call of fetchSpy.mock.calls) {
      expect(String(call[0])).toMatch(/^https:\/\/93\.184\.216\.34\//);
    }
  });

  it("reports redirects instead of following them", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 302, headers: { location: "https://example.org/moved" } })
    );

    const result = await fetchTools().execute({ name: "fetch_url", arguments: { url: "https://93.184.216.34/" } });

    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/redirect/i);
    expect(result.content).toContain("https://example.org/moved");
  });

  it("requires network approval when shell is not trusted (build mode)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const approvalHandler = vi.fn(async () => "deny" as const);

    const result = await fetchTools({ allowShell: false, approvalHandler }).execute({
      name: "fetch_url",
      arguments: { url: "https://93.184.216.34/" }
    });

    expect(approvalHandler).toHaveBeenCalledTimes(1);
    expect(approvalHandler.mock.calls[0][0].permission).toBe("network");
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/denied by permission policy/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fetches after the network approval is granted", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200, headers: { "content-type": "text/plain" } })
    );
    const approvalHandler = vi.fn(async () => "allow_once" as const);

    const result = await fetchTools({ allowShell: false, approvalHandler }).execute({
      name: "fetch_url",
      arguments: { url: "https://93.184.216.34/" }
    });

    expect(approvalHandler).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });

  it("denies fetch with no approval handler (plan mode)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await fetchTools({ allowShell: false }).execute({
      name: "fetch_url",
      arguments: { url: "https://93.184.216.34/" }
    });

    expect(result.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
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
