import { describe, expect, it } from "vitest";
import { initialAgentMode, modePermissionLabel, nextAgentMode, permissionsForMode, shouldBypassApproval } from "../src/tui/modes.js";

describe("agent modes", () => {
  it("starts in build for partial permissions and bypass only when both write and shell are enabled", () => {
    expect(initialAgentMode({ allowWrite: true, allowShell: false })).toBe("build");
    expect(initialAgentMode({ allowWrite: false, allowShell: true })).toBe("build");
    expect(initialAgentMode({ allowWrite: true, allowShell: true })).toBe("bypass");
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

  it("bypasses external file approvals only in bypass with file analysis enabled", () => {
    expect(
      shouldBypassApproval({
        mode: "bypass",
        permission: "external_file",
        permissions: {
          allowWrite: true,
          allowShell: true
        },
        allowExternalFileAnalysis: true
      })
    ).toBe(true);
    expect(
      shouldBypassApproval({
        mode: "build",
        permission: "external_file",
        permissions: {
          allowWrite: false,
          allowShell: false
        },
        allowExternalFileAnalysis: true
      })
    ).toBe(false);
    expect(
      shouldBypassApproval({
        mode: "bypass",
        permission: "external_file",
        permissions: {
          allowWrite: true,
          allowShell: true
        },
        allowExternalFileAnalysis: false
      })
    ).toBe(false);
  });
});
