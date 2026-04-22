import { describe, expect, it } from "vitest";
import { parseAgentResponse } from "../src/core/json.js";

describe("parseAgentResponse", () => {
  it("parses final responses", () => {
    expect(parseAgentResponse('{"action":"final","message":"done"}')).toEqual({
      action: "final",
      message: "done"
    });
  });

  it("extracts fenced JSON responses", () => {
    expect(
      parseAgentResponse('```json\n{"action":"tools","message":"read","tool_calls":[{"name":"list_files","arguments":{"path":"."}}]}\n```')
    ).toEqual({
      action: "tools",
      message: "read",
      tool_calls: [
        {
          name: "list_files",
          arguments: {
            path: "."
          }
        }
      ]
    });
  });
});
