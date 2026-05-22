import { describe, expect, it } from "vitest";
import { parseAgentResponse } from "../src/core/json.js";
import { toolSpecs } from "../src/core/workspace.js";

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

  it("accepts a single-object array from small local models", () => {
    expect(parseAgentResponse('[{"action":"final","message":"done"}]')).toEqual({
      action: "final",
      message: "done"
    });
  });

  it("infers tool action when a model omits the discriminator", () => {
    expect(parseAgentResponse('{"message":"read files","tool_calls":[{"name":"list_files","arguments":{"path":"."}}]}')).toEqual({
      action: "tools",
      message: "read files",
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

  it("accepts edit_file tool calls", () => {
    expect(
      parseAgentResponse(
        '{"action":"tools","message":"edit","tool_calls":[{"name":"edit_file","arguments":{"path":"index.html","find":"old","replace":"new"}}]}'
      )
    ).toEqual({
      action: "tools",
      message: "edit",
      tool_calls: [
        {
          name: "edit_file",
          arguments: {
            path: "index.html",
            find: "old",
            replace: "new"
          }
        }
      ]
    });
  });

  it("accepts document creation tool calls", () => {
    expect(
      parseAgentResponse(
        '{"action":"tools","message":"create","tool_calls":[{"name":"create_pdf","arguments":{"path":"out.pdf","content":"hello"}},{"name":"create_docx","arguments":{"path":"out.docx","content":"hello"}}]}'
      ).tool_calls.map((toolCall) => toolCall.name)
    ).toEqual(["create_pdf", "create_docx"]);
  });

  it("accepts update_todo tool calls", () => {
    expect(
      parseAgentResponse(
        '{"action":"tools","message":"plan","tool_calls":[{"name":"update_todo","arguments":{"items":[{"id":"inspect","content":"Inspect files","status":"in_progress"}]}}]}'
      ).tool_calls[0]?.name
    ).toBe("update_todo");
  });

  it("accepts every registered workspace tool name", () => {
    for (const name of Object.keys(toolSpecs)) {
      expect(
        parseAgentResponse(JSON.stringify({
          action: "tools",
          message: "call",
          tool_calls: [
            {
              name,
              arguments: {}
            }
          ]
        })).tool_calls[0]?.name
      ).toBe(name);
    }
  });

  it("truncates overlong tool batches to the protocol maximum", () => {
    const response = parseAgentResponse(
      JSON.stringify({
        action: "tools",
        message: "many",
        tool_calls: Array.from({ length: 20 }, () => ({
          name: "list_files",
          arguments: {
            path: "."
          }
        }))
      })
    );

    expect(response.action).toBe("tools");
    if (response.action === "tools") {
      expect(response.tool_calls).toHaveLength(12);
      expect(response.message).toContain("Truncated to the first 12 tool calls");
    }
  });

  it("repairs raw control characters inside JSON strings", () => {
    expect(parseAgentResponse('{"action":"final","message":"first line\nsecond line"}')).toEqual({
      action: "final",
      message: "first line\nsecond line"
    });
  });

  it("strips stray control characters outside JSON strings", () => {
    expect(parseAgentResponse('\u0000{"action":"final","message":"done"}\u0000')).toEqual({
      action: "final",
      message: "done"
    });
  });

  it("repairs a stray backslash in a code snippet (Windows path)", () => {
    // Raw backslashes before non-escape letters must survive as literals.
    const parsed = parseAgentResponse('{"action":"final","message":"see C:\\Users\\dev\\App.ts"}');
    expect(parsed).toEqual({ action: "final", message: "see C:\\Users\\dev\\App.ts" });
  });

  it("repairs a model showing a code snippet with newlines and a path", () => {
    // The model emits a file path then the file body with raw newlines —
    // exactly the "search the code and show me that snippet" case.
    const raw = '{"action":"final","message":"AnimatedText.tsx\nexport const palette = [\n  \\"#fff\\"\n];"}';
    const parsed = parseAgentResponse(raw) as { action: string; message: string };
    expect(parsed.action).toBe("final");
    expect(parsed.message).toContain("export const palette");
    expect(parsed.message).toContain('"#fff"');
  });

  it("repairs raw tabs inside JSON strings", () => {
    const parsed = parseAgentResponse('{"action":"final","message":"col1\tcol2"}') as { message: string };
    expect(parsed.message).toBe("col1\tcol2");
  });
});
