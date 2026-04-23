import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceTools } from "../src/core/workspace.js";

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
});
