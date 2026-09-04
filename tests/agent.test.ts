import { describe, expect, it } from "vitest";
import { compactTranscript, executeToolCallsWithReadParallelism, findRepeatedToolCall, isTodoOnlyFinalResponse, normalizeTodoItems, recoverMalformedToolResponse, shouldExpectTodos, shouldStopAfterEmptyToolBatches, readFinalMessage } from "../src/core/agent.js";
import type { AgentToolCall, ToolResult } from "../src/core/types.js";
import type { WorkspaceTools } from "../src/core/workspace.js";

describe("recoverMalformedToolResponse", () => {
  it("recovers a full HTML rewrite from a malformed JSON tool response", () => {
    const recovered = recoverMalformedToolResponse(
      '{"action":"tools","tool_calls":[{"name":"write_file","arguments":{"path":"index.html","content":"<!doctype html>\n<html><body><main class="card">ok</main></body></html>"}}]}'
    );

    expect(recovered).toEqual({
      action: "tools",
      message: "Recovered malformed HTML tool response.",
      tool_calls: [
        {
          name: "write_file",
          arguments: {
            path: "index.html",
            content: '<!doctype html>\n<html><body><main class="card">ok</main></body></html>'
          }
        }
      ]
    });
  });

  it("does not infer write targets from fenced HTML explanations", () => {
    const recovered = recoverMalformedToolResponse(
      "Here is the updated file:\n```html\n<!doctype html>\n<html><body>ok</body></html>\n```"
    );

    expect(recovered).toBeNull();
  });

  it("ignores unrelated paths before the write_file tool call", () => {
    const recovered = recoverMalformedToolResponse(
      '{"path":"notes.txt","action":"tools","tool_calls":[{"name":"write_file","arguments":{"path":"index.html","content":"<!doctype html>\\n<html><body>ok</body></html>"}}]}'
    );

    expect(recovered?.tool_calls[0]?.arguments.path).toBe("index.html");
  });
});

describe("executeToolCallsWithReadParallelism", () => {
  it("runs contiguous read-only calls in parallel while keeping output order", async () => {
    let activeCalls = 0;
    let maxActiveCalls = 0;
    const tools = {
      execute: async (call: AgentToolCall): Promise<ToolResult> => {
        activeCalls += 1;
        maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
        await sleep(20);
        activeCalls -= 1;
        return {
          ok: true,
          summary: call.name,
          content: call.name,
          tool: call.name
        };
      }
    } as WorkspaceTools;

    const results = await executeToolCallsWithReadParallelism(tools, [
      toolRecord("read_file", "read-1"),
      toolRecord("find_files", "find-1"),
      toolRecord("search_text", "search-1"),
      toolRecord("git_status", "status-1")
    ]);

    expect(maxActiveCalls).toBe(4);
    expect(results.map((result) => result.toolCallId)).toEqual(["read-1", "find-1", "search-1", "status-1"]);
  });

  it("keeps mutating calls as ordering barriers", async () => {
    const events: string[] = [];
    const tools = {
      execute: async (call: AgentToolCall): Promise<ToolResult> => {
        events.push(`start:${call.name}`);
        await sleep(5);
        events.push(`end:${call.name}`);
        return {
          ok: true,
          summary: call.name,
          content: call.name,
          tool: call.name
        };
      }
    } as WorkspaceTools;

    await executeToolCallsWithReadParallelism(tools, [
      toolRecord("read_file", "read-before"),
      toolRecord("write_file", "write"),
      toolRecord("read_file", "read-after")
    ]);

    expect(events).toEqual([
      "start:read_file",
      "end:read_file",
      "start:write_file",
      "end:write_file",
      "start:read_file",
      "end:read_file"
    ]);
  });
});

describe("normalizeTodoItems", () => {
  it("normalizes visible todo snapshots", () => {
    expect(
      normalizeTodoItems({
        items: [
          { id: "Inspect Files", content: "Inspect files", status: "current" },
          { content: "Run checks", status: "done" },
          { content: "Ship release" }
        ]
      })
    ).toEqual([
      { id: "inspect-files", content: "Inspect files", status: "in_progress" },
      { id: "run-checks", content: "Run checks", status: "completed" },
      { id: "ship-release", content: "Ship release", status: "pending" }
    ]);
  });
});

describe("agent loop guards", () => {
  it("detects multi-step implementation tasks that should start with todos", () => {
    expect(shouldExpectTodos("fix provider retries and run the tests after changing the backend")).toBe(true);
    expect(shouldExpectTodos("what stack is this")).toBe(false);
    expect(shouldExpectTodos("tiny", true)).toBe(true);
  });

  it("detects repeated identical workspace tool calls with stable argument order", () => {
    const recent: string[] = [];
    expect(findRepeatedToolCall([{ name: "read_file", arguments: { path: "src/a.ts", mode: "full" } }], recent)).toBeNull();
    expect(findRepeatedToolCall([{ name: "read_file", arguments: { mode: "full", path: "src/a.ts" } }], recent)).toBeNull();
    expect(findRepeatedToolCall([{ name: "read_file", arguments: { path: "src/a.ts", mode: "full" } }], recent)?.name).toBe("read_file");
  });

  it("stops after repeated empty tool batches", () => {
    expect(shouldStopAfterEmptyToolBatches(1)).toBe(false);
    expect(shouldStopAfterEmptyToolBatches(2)).toBe(true);
  });

  it("rejects todo-only or deferred final answers", () => {
    expect(isTodoOnlyFinalResponse("Die Todo-Liste wurde aktualisiert, der Überblick steht im vorherigen Schritt.")).toBe(true);
    expect(isTodoOnlyFinalResponse("Todo list updated.")).toBe(true);
    expect(isTodoOnlyFinalResponse("Done.")).toBe(true);
    expect(
      isTodoOnlyFinalResponse(
        "Fixed the final-answer guard in src/core/agent.ts, tightened ultramaxx activation, and verified the focused Vitest files."
      )
    ).toBe(false);
    expect(isTodoOnlyFinalResponse("Updated the todo list, fixed src/core/agent.ts, and verified tests/agent.test.ts.")).toBe(false);
  });

  it("compacts older tool-result transcript blocks and keeps recent ones verbatim", () => {
    const messages = [
      { role: "system" as const, content: "system" },
      { role: "user" as const, content: "task" },
      toolResultMessage("read_file", "old file content".repeat(100)),
      toolResultMessage("search_text", "middle search output"),
      toolResultMessage("git_diff", "recent diff")
    ];

    compactTranscript(messages, 1);

    expect(messages[2]?.content).toContain("Compacted earlier tool results");
    expect(messages[3]?.content).toContain("\"tool_results\"");
    expect(messages[4]?.content).toContain("\"tool_results\"");
  });
});

function toolRecord(name: AgentToolCall["name"], id: string) {
  return {
    id,
    call: {
      name,
      arguments: name === "search_text" || name === "find_files" ? { query: "needle" } : name === "git_status" ? {} : { path: "src/index.ts" }
    },
    workState: "reading" as const
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function toolResultMessage(tool: string, content: string) {
  return {
    role: "user" as const,
    content: [
      "Tool results are encoded as JSON.",
      JSON.stringify({
        tool_results: [
          {
            index: 1,
            tool,
            ok: true,
            summary: `${tool} summary`,
            content
          }
        ]
      })
    ].join("\n")
  };
}

describe("final message unwrapping", () => {
  it("strips a narrated protocol envelope down to its message", () => {
    expect(readFinalMessage('{"action":"final","message":"Added farewell()."}')).toBe("Added farewell().");
    expect(readFinalMessage('{"action":"tools","message":"working","tool_calls":[{"name":"read"}]}')).toBe("working");
  });

  it("leaves ordinary prose alone", () => {
    expect(readFinalMessage("  I added the function and tests pass.  ")).toBe("I added the function and tests pass.");
  });

  it("decodes escapes inside the message", () => {
    expect(readFinalMessage('{"action":"final","message":"Edited \\"hello.py\\"."}')).toBe('Edited "hello.py".');
  });

  it("falls back rather than showing raw JSON when there is no message", () => {
    expect(readFinalMessage('{"action":"final"}')).toBe("Done.");
  });
});

describe("todo item shapes", () => {
  it("accepts the title key the tool schema asks for", () => {
    const items = normalizeTodoItems({ items: [{ title: "Read the parser", status: "in_progress" }] });
    expect(items).toEqual([{ id: "read-the-parser", content: "Read the parser", status: "in_progress" }]);
  });

  it("still accepts the shapes models reach for unprompted", () => {
    for (const key of ["content", "text", "task", "description"]) {
      const items = normalizeTodoItems({ items: [{ [key]: "Do the thing", status: "pending" }] });
      expect(items[0]?.content).toBe("Do the thing");
    }
  });

  it("drops items with no usable text rather than showing a blank row", () => {
    expect(normalizeTodoItems({ items: [{ status: "pending" }, { title: "  " }] })).toEqual([]);
  });
});
