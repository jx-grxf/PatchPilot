import { describe, expect, it } from "vitest";
import { initialAgentMode, modePermissionLabel, nextAgentMode, permissionsForMode } from "../src/tui/modes.js";

describe("agent modes", () => {
  it("starts in bypass when global write or shell permissions are already enabled", () => {
    expect(initialAgentMode({ allowWrite: true, allowShell: false })).toBe("bypass");
    expect(initialAgentMode({ allowWrite: false, allowShell: true })).toBe("bypass");
    expect(initialAgentMode({ allowWrite: false, allowShell: false })).toBe("plan");
  });

  it("cycles plan to build to bypass", () => {
    expect(nextAgentMode("plan")).toBe("build");
    expect(nextAgentMode("build")).toBe("bypass");
    expect(nextAgentMode("bypass")).toBe("plan");
  });

  it("keeps plan read-only, build approval-gated, and bypass fully enabled", () => {
    expect(permissionsForMode("plan")).toEqual({ allowWrite: false, allowShell: false });
    expect(permissionsForMode("build")).toEqual({ allowWrite: false, allowShell: false });
    expect(permissionsForMode("bypass")).toEqual({ allowWrite: true, allowShell: true });

    expect(modePermissionLabel("plan", "write")).toBe("off");
    expect(modePermissionLabel("build", "write")).toBe("approval");
    expect(modePermissionLabel("bypass", "shell")).toBe("on");
  });
});
