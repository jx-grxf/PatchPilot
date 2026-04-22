import { describe, expect, it } from "vitest";
import { routeLocalConversation } from "../src/tui/inputRouting.js";

describe("routeLocalConversation", () => {
  it("handles greetings without starting the agent", () => {
    expect(routeLocalConversation("hey")).toEqual(
      expect.objectContaining({
        handled: true,
        tone: "accent"
      })
    );
  });

  it("rejects tiny ambiguous inputs", () => {
    expect(routeLocalConversation("files maybe")).toEqual(
      expect.objectContaining({
        handled: true,
        tone: "warning"
      })
    );
  });

  it("lets coding tasks reach the agent", () => {
    expect(routeLocalConversation("summarize this repository")).toEqual({
      handled: false
    });
  });

  it("clarifies single-word coding verbs", () => {
    expect(routeLocalConversation("summarize")).toEqual(
      expect.objectContaining({
        handled: true,
        tone: "warning"
      })
    );
  });
});
