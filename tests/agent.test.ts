import { describe, expect, it } from "vitest";
import { executeToolCallsWithReadParallelism, normalizeTodoItems, recoverMalformedToolResponse } from "../src/core/agent.js";
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
      toolRecord("search_text", "search-1"),
      toolRecord("git_status", "status-1")
    ]);

    expect(maxActiveCalls).toBe(3);
    expect(results.map((result) => result.toolCallId)).toEqual(["read-1", "search-1", "status-1"]);
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

function toolRecord(name: AgentToolCall["name"], id: string) {
  return {
    id,
    call: {
      name,
      arguments: name === "search_text" ? { query: "needle" } : name === "git_status" ? {} : { path: "src/index.ts" }
    },
    workState: "reading" as const
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
