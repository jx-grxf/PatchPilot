import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
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
