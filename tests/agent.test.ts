import { describe, expect, it } from "vitest";
import { recoverMalformedToolResponse } from "../src/core/agent.js";

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

  it("falls back to the last read file path for fenced HTML", () => {
    const recovered = recoverMalformedToolResponse(
      "Here is the updated file:\n```html\n<!doctype html>\n<html><body>ok</body></html>\n```",
      "code_tests/rand_gen/index.html"
    );

    expect(recovered?.tool_calls[0]?.arguments.path).toBe("code_tests/rand_gen/index.html");
    expect(recovered?.tool_calls[0]?.arguments.content).toContain("<body>ok</body>");
  });
});
