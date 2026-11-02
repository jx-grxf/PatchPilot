import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApprovalRequest, PermissionDecision, ToolResult } from "../src/core/types.js";
import { WorkspaceTools } from "../src/core/workspace.js";
import { serializeApprovals, WriteCoordinator } from "../src/core/writeCoordinator.js";

const execFileAsync = promisify(execFile);

let root = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "patchpilot-coordinator-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function agent(coordinator: WriteCoordinator, agentKey: string): WorkspaceTools {
  return new WorkspaceTools({ root, allowWrite: true, allowShell: false, coordinator, agentKey });
}

const read = (tools: WorkspaceTools, file: string) => tools.execute({ name: "read_file", arguments: { path: file } });
const write = (tools: WorkspaceTools, file: string, content: string) => tools.execute({ name: "write_file", arguments: { path: file, content } });
const edit = (tools: WorkspaceTools, file: string, find: string, replace: string) =>
  tools.execute({ name: "edit_file", arguments: { path: file, find, replace } });

async function put(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), content, "utf8");
}

const disk = (file: string) => readFile(path.join(root, file), "utf8");

describe("WriteCoordinator staleness", () => {
  it("refuses a write when the file changed since the agent read it, naming the writer", async () => {
    await put("src/a.ts", "one\n");
    const coordinator = new WriteCoordinator();
    const first = agent(coordinator, "agent-1");
    const second = agent(coordinator, "agent-2");

    await read(first, "src/a.ts");
    await read(second, "src/a.ts");
    expect((await write(second, "src/a.ts", "two\n")).ok).toBe(true);

    const refused = await write(first, "src/a.ts", "three\n");
    expect(refused.ok).toBe(false);
    expect(refused.content).toBe("src/a.ts changed since you last read it (agent-2 wrote it). Read it again, then retry.");
    expect(await disk("src/a.ts")).toBe("two\n");
  });

  it("accepts the retry after reading again, and a refused write does not count as seen", async () => {
    await put("a.ts", "one\n");
    const coordinator = new WriteCoordinator();
    const first = agent(coordinator, "agent-1");
    const second = agent(coordinator, "agent-2");

    await read(first, "a.ts");
    await write(second, "a.ts", "two\n");
    expect((await write(first, "a.ts", "three\n")).ok).toBe(false);
    expect((await write(first, "a.ts", "three\n")).ok).toBe(false);

    await read(first, "a.ts");
    expect((await write(first, "a.ts", "three\n")).ok).toBe(true);
    expect(await disk("a.ts")).toBe("three\n");
  });

  it("refuses an agent that never read a file another agent wrote", async () => {
    await put("a.ts", "one\n");
    const coordinator = new WriteCoordinator();
    const first = agent(coordinator, "agent-1");
    const second = agent(coordinator, "agent-2");

    await write(first, "a.ts", "two\n");
    const refused = await write(second, "a.ts", "three\n");
    expect(refused.ok).toBe(false);
    expect(refused.content).toBe("a.ts was written by agent-1 and you have not read it. Read it, then retry.");

    await read(second, "a.ts");
    expect((await write(second, "a.ts", "three\n")).ok).toBe(true);
  });

  it("lets an agent write an untouched file it never read, and a new file nobody saw", async () => {
    await put("old.ts", "one\n");
    const coordinator = new WriteCoordinator();
    const tools = agent(coordinator, "agent-1");

    expect((await write(tools, "old.ts", "two\n")).ok).toBe(true);
    expect((await write(tools, "src/new.ts", "fresh\n")).ok).toBe(true);
    expect((await write(agent(coordinator, "agent-3"), "src/brand-new.ts", "x\n")).ok).toBe(true);
  });

  it("treats a file deleted since the agent saw it as stale, until the agent reads the gap", async () => {
    await put("a.ts", "one\n");
    const coordinator = new WriteCoordinator();
    const tools = agent(coordinator, "agent-1");

    await read(tools, "a.ts");
    await rm(path.join(root, "a.ts"));

    const refused = await write(tools, "a.ts", "back\n");
    expect(refused.ok).toBe(false);
    expect(refused.content).toBe("a.ts was deleted since you last read it. Read it again to confirm, then retry.");

    expect((await read(tools, "a.ts")).ok).toBe(false);
    expect((await write(tools, "a.ts", "back\n")).ok).toBe(true);
  });

  it("counts a partial read as seen using the whole file's hash", async () => {
    await put("a.ts", "1\n2\n3\n4\n");
    const coordinator = new WriteCoordinator();
    const first = agent(coordinator, "agent-1");
    const second = agent(coordinator, "agent-2");

    await first.execute({ name: "read_range", arguments: { path: "a.ts", start: 1, end: 2 } });
    await write(second, "a.ts", "changed\n");
    expect((await edit(first, "a.ts", "changed", "mine")).ok).toBe(false);

    await first.execute({ name: "read_range", arguments: { path: "a.ts", start: 1, end: 1 } });
    expect((await edit(first, "a.ts", "changed", "mine")).ok).toBe(true);
    expect(await disk("a.ts")).toBe("mine\n");
  });

  it("counts inspect_document on a text file as a read", async () => {
    await put("notes.md", "a\n");
    const coordinator = new WriteCoordinator();
    const first = agent(coordinator, "agent-1");
    await first.execute({ name: "inspect_document", arguments: { path: "notes.md" } });
    await write(agent(coordinator, "agent-2"), "notes.md", "b\n");
    expect((await write(first, "notes.md", "c\n")).ok).toBe(false);
  });

  it("counts a successful write as seen, so the writer can write again", async () => {
    await put("a.ts", "one\n");
    const coordinator = new WriteCoordinator();
    const tools = agent(coordinator, "agent-1");

    await read(tools, "a.ts");
    expect((await write(tools, "a.ts", "two\n")).ok).toBe(true);
    expect((await edit(tools, "a.ts", "two", "three")).ok).toBe(true);
    expect(await disk("a.ts")).toBe("three\n");
  });

  it("does not count a failed edit as seen", async () => {
    await put("a.ts", "one\n");
    const coordinator = new WriteCoordinator();
    const first = agent(coordinator, "agent-1");
    await read(first, "a.ts");
    await write(agent(coordinator, "agent-2"), "a.ts", "two\n");

    expect((await edit(first, "a.ts", "missing text", "x")).ok).toBe(false);
    expect((await write(first, "a.ts", "three\n")).ok).toBe(false);
  });

  it("lets exactly one of two agents win when both read the same version", async () => {
    await put("a.ts", "base\n");
    const coordinator = new WriteCoordinator();
    const first = agent(coordinator, "agent-1");
    const second = agent(coordinator, "agent-2");
    await read(first, "a.ts");
    await read(second, "a.ts");

    const results = await Promise.all([write(first, "a.ts", "from one\n"), write(second, "a.ts", "from two\n")]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    const winner = results[0]?.ok ? "from one\n" : "from two\n";
    expect(await disk("a.ts")).toBe(winner);
  });

  it("serialises check and write across paths and survives a throwing write", async () => {
    const coordinator = new WriteCoordinator();
    const order: string[] = [];
    const slow = coordinator.withWrite("agent-1", path.join(root, "x"), async () => {
      order.push("slow start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("slow end");
      throw new Error("disk full");
    });
    const next = coordinator.withWrite("agent-2", path.join(root, "y"), async () => {
      order.push("next");
      return 1;
    });

    await expect(slow).rejects.toThrow("disk full");
    expect(await next).toEqual({ ok: true, value: 1 });
    expect(order).toEqual(["slow start", "slow end", "next"]);
  });
});

describe("apply_patch with a coordinator", () => {
  async function initRepo(): Promise<void> {
    await execFileAsync("git", ["init"], { cwd: root });
  }

  const patch = (file: string, from: string, to: string) =>
    [`--- a/${file}`, `+++ b/${file}`, "@@ -1 +1 @@", `-${from}`, `+${to}`, ""].join("\n");

  it("refuses the whole patch, names the stale path and writes nothing", async () => {
    await initRepo();
    await put("one.txt", "a\n");
    await put("two.txt", "b\n");
    const coordinator = new WriteCoordinator();
    const first = agent(coordinator, "agent-1");
    await read(first, "one.txt");
    await read(first, "two.txt");
    await write(agent(coordinator, "agent-2"), "two.txt", "other\n");

    const result = await first.execute({ name: "apply_patch", arguments: { patch: patch("one.txt", "a", "A") + patch("two.txt", "b", "B") } });

    expect(result.ok).toBe(false);
    expect(result.content).toBe("two.txt changed since you last read it (agent-2 wrote it). Read it again, then retry.");
    expect(await disk("one.txt")).toBe("a\n");
    expect(await disk("two.txt")).toBe("other\n");
  });

  it("applies when every path is current and counts them as seen", async () => {
    await initRepo();
    await put("one.txt", "a\n");
    await put("two.txt", "b\n");
    const coordinator = new WriteCoordinator();
    const first = agent(coordinator, "agent-1");
    await read(first, "one.txt");
    await read(first, "two.txt");

    const result = await first.execute({ name: "apply_patch", arguments: { patch: patch("one.txt", "a", "A") + patch("two.txt", "b", "B") } });
    expect(result.ok).toBe(true);
    expect(await disk("one.txt")).toBe("A\n");
    expect((await write(first, "two.txt", "again\n")).ok).toBe(true);
  });

  it("does not count a patch that git rejects as seen", async () => {
    await initRepo();
    await put("one.txt", "a\n");
    const coordinator = new WriteCoordinator();
    const first = agent(coordinator, "agent-1");
    await read(first, "one.txt");
    await write(agent(coordinator, "agent-2"), "one.txt", "other\n");

    const bad = await first.execute({ name: "apply_patch", arguments: { patch: patch("one.txt", "nope", "x") } });
    expect(bad.ok).toBe(false);
    expect((await write(first, "one.txt", "mine\n")).ok).toBe(false);
  });
});

describe("approval prompts stay outside the serialised step", () => {
  it("does not block another agent's write while a prompt is waiting", async () => {
    await put("a.ts", "one\n");
    await put("b.ts", "one\n");
    const coordinator = new WriteCoordinator();
    let release: (decision: PermissionDecision) => void = () => undefined;
    const waiting = new Promise<PermissionDecision>((resolve) => {
      release = resolve;
    });
    const slow = new WorkspaceTools({ root, allowWrite: false, allowShell: false, coordinator, agentKey: "agent-1", approvalHandler: () => waiting });

    const pending = write(slow, "a.ts", "slow\n");
    const other = await write(agent(coordinator, "agent-2"), "b.ts", "fast\n");
    expect(other.ok).toBe(true);

    release("allow_once");
    expect((await pending).ok).toBe(true);
  });

  it("refuses an edit whose file changed while the approval was open", async () => {
    await put("a.ts", "one\n");
    const coordinator = new WriteCoordinator();
    let release: (decision: PermissionDecision) => void = () => undefined;
    const waiting = new Promise<PermissionDecision>((resolve) => {
      release = resolve;
    });
    const slow = new WorkspaceTools({ root, allowWrite: false, allowShell: false, coordinator, agentKey: "agent-1", approvalHandler: () => waiting });

    const pending = edit(slow, "a.ts", "one", "two");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await write(agent(coordinator, "agent-2"), "a.ts", "one\nplus\n");
    release("allow_once");

    const result = await pending;
    expect(result.ok).toBe(false);
    expect(await disk("a.ts")).toBe("one\nplus\n");
  });
});

describe("without a coordinator", () => {
  it("behaves as before: reads never block writes", async () => {
    await put("a.ts", "one\n");
    const first = new WorkspaceTools({ root, allowWrite: true, allowShell: false });
    const second = new WorkspaceTools({ root, allowWrite: true, allowShell: false });
    await read(first, "a.ts");
    await write(second, "a.ts", "two\n");

    const result: ToolResult = await write(first, "a.ts", "three\n");
    expect(result.ok).toBe(true);
    expect(await disk("a.ts")).toBe("three\n");
  });
});

describe("serializeApprovals", () => {
  const request = (id: string, signal?: AbortSignal): ApprovalRequest => ({
    id,
    tool: "write_file",
    permission: "write",
    risk: "medium",
    preview: id,
    arguments: {},
    signal
  });

  it("opens one prompt at a time, in order", async () => {
    const log: string[] = [];
    let open = 0;
    let maxOpen = 0;
    const handler = serializeApprovals(async (item) => {
      open += 1;
      maxOpen = Math.max(maxOpen, open);
      log.push(`start ${item.id}`);
      await new Promise((resolve) => setTimeout(resolve, item.id === "a" ? 30 : 1));
      log.push(`end ${item.id}`);
      open -= 1;
      return "allow_once";
    });

    const decisions = await Promise.all([handler(request("a")), handler(request("b")), handler(request("c"))]);

    expect(decisions).toEqual(["allow_once", "allow_once", "allow_once"]);
    expect(maxOpen).toBe(1);
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
  });

  it("denies a request that aborted before its turn without prompting", async () => {
    const seen: string[] = [];
    const handler = serializeApprovals(async (item) => {
      seen.push(item.id);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return "allow_session";
    });
    const controller = new AbortController();

    const first = handler(request("a"));
    const second = handler(request("b", controller.signal));
    controller.abort();

    expect(await first).toBe("allow_session");
    expect(await second).toBe("deny");
    expect(await handler(request("c", controller.signal))).toBe("deny");
    expect(seen).toEqual(["a"]);
  });

  it("keeps serving after a handler rejects or throws", async () => {
    let calls = 0;
    const handler = serializeApprovals((item) => {
      calls += 1;
      if (item.id === "a") {
        return Promise.reject(new Error("prompt crashed"));
      }
      if (item.id === "b") {
        throw new Error("sync crash");
      }
      return Promise.resolve("allow_once");
    });

    const results = await Promise.allSettled([handler(request("a")), handler(request("b")), handler(request("c"))]);

    expect(results[0]?.status).toBe("rejected");
    expect(results[1]?.status).toBe("rejected");
    expect(results[2]).toEqual({ status: "fulfilled", value: "allow_once" });
    expect(calls).toBe(3);
  });
});
