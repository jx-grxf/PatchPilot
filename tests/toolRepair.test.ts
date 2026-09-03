import { describe, expect, it } from "vitest";
import {
  extractFencedToolCalls,
  looksLikePermissionRequest,
  parseLooseJson,
  repairToolCall,
  resolveToolName,
  ToolCallLoopBreaker
} from "../src/core/toolRepair.js";
import { toolsForMode, toProviderTools, toWorkspaceCall } from "../src/core/toolSchema.js";

function repaired(name: unknown, args: unknown) {
  const result = repairToolCall({ name, arguments: args });
  if ("message" in result) {
    throw new Error(`expected a repaired call, got problem: ${result.message}`);
  }
  return result;
}

function problem(name: unknown, args: unknown) {
  const result = repairToolCall({ name, arguments: args });
  if (!("message" in result)) {
    throw new Error(`expected a problem, got a repaired call for ${String(name)}`);
  }
  return result.message;
}

describe("L3 — tool name resolution", () => {
  it("accepts the real names unchanged", () => {
    expect(resolveToolName("read")).toEqual({ name: "read", aliased: false });
    expect(resolveToolName("fetch_url")).toEqual({ name: "fetch_url", aliased: false });
  });

  it("normalizes case, spacing and hyphens", () => {
    expect(resolveToolName("  Read ")).toMatchObject({ name: "read" });
    expect(resolveToolName("fetch-url")).toMatchObject({ name: "fetch_url" });
  });

  it("maps shell and other-harness habits onto the real surface", () => {
    expect(resolveToolName("ls")).toMatchObject({ name: "glob", aliased: true });
    expect(resolveToolName("rg")).toMatchObject({ name: "grep", aliased: true });
    expect(resolveToolName("cat")).toMatchObject({ name: "read", aliased: true });
    expect(resolveToolName("str_replace")).toMatchObject({ name: "edit", aliased: true });
    expect(resolveToolName("run_shell")).toMatchObject({ name: "bash", aliased: true });
    expect(resolveToolName("git")).toMatchObject({ name: "bash", aliased: true });
  });

  it("unwraps namespaced call names", () => {
    expect(resolveToolName("functions.read")).toMatchObject({ name: "read", aliased: true });
    expect(resolveToolName("tool:grep")).toMatchObject({ name: "grep", aliased: true });
  });

  it("refuses names it cannot place", () => {
    expect(resolveToolName("teleport")).toBeNull();
    expect(resolveToolName(42)).toBeNull();
  });
});

describe("L3 — argument coercion", () => {
  it("renames synonym arguments rather than failing the call", () => {
    const call = repaired("read", { file: "src/a.ts" });
    expect(call.arguments).toEqual({ path: "src/a.ts" });
    expect(call.repairs).toContain("argument file -> path");
  });

  it("maps every edit synonym onto the schema", () => {
    const call = repaired("edit", { file_path: "a.ts", old: "x", new: "y" });
    expect(call.arguments).toEqual({ path: "a.ts", old_string: "x", new_string: "y" });
  });

  it("parses numbers and booleans supplied as strings", () => {
    expect(repaired("read", { path: "a.ts", offset: "10", limit: "5" }).arguments).toMatchObject({ offset: 10, limit: 5 });
    expect(repaired("edit", { path: "a", old_string: "x", new_string: "y", replace_all: "true" }).arguments).toMatchObject({
      replace_all: true
    });
  });

  it("accepts an arguments object handed over as a JSON string", () => {
    expect(repaired("read", '{"path":"src/a.ts"}').arguments).toEqual({ path: "src/a.ts" });
  });

  it("drops unknown arguments instead of rejecting a usable call", () => {
    const call = repaired("read", { path: "a.ts", encoding: "utf8" });
    expect(call.arguments).toEqual({ path: "a.ts" });
    expect(call.repairs.some((entry) => entry.includes("encoding"))).toBe(true);
  });
});

describe("L4 — errors that say what to do next", () => {
  it("names the missing argument and shows a concrete call", () => {
    const message = problem("read", {});
    expect(message).toContain('needs "path"');
    expect(message).toContain('read({"path":"<path>"}');
  });

  it("lists the real tools when the name is unknown", () => {
    expect(problem("teleport", {})).toContain("read, write, edit, glob, grep, bash, fetch_url, task, todo");
  });

  it("lists the permitted values for an enum", () => {
    expect(problem("task", { description: "d", prompt: "p", subagent_type: "wizard" })).toContain("explore, general");
  });

  it("says which type was expected when a value cannot be coerced", () => {
    expect(problem("todo", { items: "not-an-array" })).toContain("an array");
  });

  it("never emits a bare rejection", () => {
    for (const message of [problem("read", {}), problem("teleport", {}), problem("bash", {})]) {
      expect(message.toLowerCase()).not.toBe("invalid input");
      expect(message.length).toBeGreaterThan(40);
    }
  });
});

describe("L2 — tool calls printed instead of called", () => {
  it("recovers a call from a fenced json block", () => {
    const calls = extractFencedToolCalls('Sure, I will read it.\n```json\n{"name":"read","arguments":{"path":"a.ts"}}\n```');
    expect(calls).toHaveLength(1);
    expect(repaired(calls[0]?.name, calls[0]?.arguments).arguments).toEqual({ path: "a.ts" });
  });

  it("recovers several calls from one block", () => {
    const calls = extractFencedToolCalls('```\n[{"name":"read","arguments":{"path":"a"}},{"name":"grep","arguments":{"pattern":"x"}}]\n```');
    expect(calls.map((call) => call.name)).toEqual(["read", "grep"]);
  });

  it("accepts the alternative key names models use", () => {
    const calls = extractFencedToolCalls('```json\n{"tool":"grep","parameters":{"pattern":"todo"}}\n```');
    expect(repaired(calls[0]?.name, calls[0]?.arguments)).toMatchObject({ name: "grep" });
  });

  it("ignores fenced code that is not a tool call", () => {
    expect(extractFencedToolCalls('```ts\nconst x = 1;\n```')).toEqual([]);
  });
});

describe("L3 — near-miss JSON", () => {
  it("tolerates trailing commas", () => {
    expect(parseLooseJson('{"path":"a.ts",}')).toEqual({ path: "a.ts" });
  });

  it("tolerates single-quoted keys and values", () => {
    expect(parseLooseJson("{'path':'a.ts'}")).toEqual({ path: "a.ts" });
  });

  it("closes a payload cut off by the token budget", () => {
    expect(parseLooseJson('{"path":"a.ts","content":"hello')).toEqual({ path: "a.ts", content: "hello" });
    expect(parseLooseJson('{"items":[{"title":"x"')).toEqual({ items: [{ title: "x" }] });
  });

  it("leaves apostrophes inside real content alone", () => {
    expect(parseLooseJson('{"content":"it\'s fine"}')).toEqual({ content: "it's fine" });
  });

  it("returns null when there is nothing recoverable", () => {
    expect(parseLooseJson("not json at all")).toBeNull();
    expect(parseLooseJson("")).toBeNull();
  });
});

describe("L5 — loop breaker", () => {
  it("allows retries up to the limit, then refuses with guidance", () => {
    const breaker = new ToolCallLoopBreaker(2);
    const args = { command: "npm test" };

    expect(breaker.check("bash", args)).toBeNull();
    breaker.recordFailure("bash", args);
    expect(breaker.check("bash", args)).toBeNull();
    breaker.recordFailure("bash", args);

    const refusal = breaker.check("bash", args);
    expect(refusal?.message).toContain("Do not repeat it");
    expect(refusal?.message).toContain("Change the arguments");
  });

  it("keys on arguments, not just the tool name", () => {
    const breaker = new ToolCallLoopBreaker(1);
    breaker.recordFailure("bash", { command: "a" });
    expect(breaker.check("bash", { command: "a" })).not.toBeNull();
    expect(breaker.check("bash", { command: "b" })).toBeNull();
  });

  it("ignores argument ordering", () => {
    const breaker = new ToolCallLoopBreaker(1);
    breaker.recordFailure("edit", { path: "a", old_string: "x" });
    expect(breaker.check("edit", { old_string: "x", path: "a" })).not.toBeNull();
  });

  it("never counts successful calls", () => {
    const breaker = new ToolCallLoopBreaker(1);
    for (let index = 0; index < 10; index += 1) {
      expect(breaker.check("read", { path: "a.ts" })).toBeNull();
    }
  });
});

describe("L6 — intent guard", () => {
  it("spots a permission request despite an act-don't-ask instruction", () => {
    expect(looksLikePermissionRequest("Shall I go ahead and edit the file?")).toBe(true);
    expect(looksLikePermissionRequest("Would you like me to run the tests?")).toBe(true);
    expect(looksLikePermissionRequest("Soll ich das jetzt ändern?")).toBe(true);
  });

  it("leaves genuine clarifying questions and normal prose alone", () => {
    expect(looksLikePermissionRequest("I edited the file and tests pass.")).toBe(false);
    expect(looksLikePermissionRequest("Which of the two configs is authoritative?")).toBe(false);
  });
});

describe("tool surface", () => {
  it("exposes nine tools, and only read-only ones in plan mode", () => {
    expect(toolsForMode("build")).toHaveLength(9);
    const planTools = toolsForMode("plan").map((tool) => tool.name);
    expect(planTools).not.toContain("write");
    expect(planTools).not.toContain("edit");
    expect(planTools).not.toContain("bash");
    expect(planTools).toContain("read");
  });

  it("hides the task tool when subagents are off", () => {
    expect(toolsForMode("build", { subagents: false }).map((tool) => tool.name)).not.toContain("task");
  });

  it("emits schemas both runtimes accept", () => {
    for (const tool of toProviderTools(toolsForMode("build"))) {
      expect(tool.type).toBe("function");
      expect(tool.function.description.length).toBeGreaterThan(40);
      expect(tool.function.parameters.additionalProperties).toBe(false);
    }
  });

  it("maps the nine-tool surface onto the workspace implementation", () => {
    expect(toWorkspaceCall("read", { path: "a.ts" })).toEqual({ name: "read_file", arguments: { path: "a.ts" } });
    expect(toWorkspaceCall("read", { path: "a.ts", offset: 10, limit: 5 })).toMatchObject({
      name: "read_range",
      arguments: { start: 10, end: 14 }
    });
    expect(toWorkspaceCall("bash", { command: "git status" })).toEqual({
      name: "run_shell",
      arguments: { command: "git status" }
    });
    expect(toWorkspaceCall("grep", { pattern: "todo" })).toMatchObject({ name: "search_text" });
  });
});
