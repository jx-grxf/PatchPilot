import { describe, expect, it } from "vitest";
import { normalizeTodoItems, recoverMalformedToolResponse } from "../src/core/agent.js";

describe("recoverMalformedToolResponse", () => {
  it("recovers a full HTML rewrite from a malformed JSON tool response", () => {
    const recovered = recoverMalformedToolResponse(
      '{"action":"tools","tool_calls":[{"name":"write_file","arguments":{"path":"index.html","content":"<!doctype html>\n<html><body><main class="card">ok</main></body></html>"}}]}',
      ""
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
      "Here is the updated file:\n```html\n<!doctype html>\n<html><body>ok</body></html>\n```",
      "code_tests/rand_gen/index.html"
    );

    expect(recovered).toBeNull();
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
