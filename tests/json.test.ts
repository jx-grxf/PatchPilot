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
