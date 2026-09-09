import { describe, expect, it } from "vitest";
import { experimentalFlagEnvName } from "../src/tui/components/ExperimentalPanel.js";

describe("experimental setting persistence", () => {
  it("uses the canonical subagent setting key", () => {
    expect(experimentalFlagEnvName("subagents")).toBe("PATCHPILOT_SUBAGENTS");
  });

  it("keeps the remaining experimental keys explicit", () => {
    expect(experimentalFlagEnvName("fileAnalysis")).toBe("PATCHPILOT_EXPERIMENTAL_FILE_ANALYSIS");
    expect(experimentalFlagEnvName("memory")).toBe("PATCHPILOT_EXPERIMENTAL_MEMORY");
    expect(experimentalFlagEnvName("shellMetacharacters")).toBe("PATCHPILOT_EXPERIMENTAL_SHELL_METACHARACTERS");
  });
});
