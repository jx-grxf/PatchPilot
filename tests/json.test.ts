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
});
