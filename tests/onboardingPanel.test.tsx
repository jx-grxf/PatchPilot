import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { OnboardingPanel, type OnboardingState } from "../src/tui/components/OnboardingPanel.js";
import { installGuide } from "../src/tui/onboardingSetup.js";

function frame(state: OnboardingState): string {
  const { lastFrame, unmount } = render(
    <OnboardingPanel state={state} selectedIndex={0} input="" onInputChange={() => {}} onInputSubmit={() => {}} />
  );
  const output = lastFrame() ?? "";
  unmount();
  return output;
}

describe("OnboardingPanel", () => {
  it("lists detected runtimes", () => {
    const output = frame({
      step: "entry",
      choices: [{ kind: "ollama-local", label: "Ollama", description: "running · 2 models · this device", running: true, modelCount: 2 }]
    });
    expect(output).toContain("Where should the model run?");
    expect(output).toContain("running · 2 models");
  });

  it("shows install commands for the system", () => {
    const output = frame({ step: "install", guide: installGuide("linux", "x64") });
    expect(output).toContain("curl -fsSL https://ollama.com/install.sh | sh");
    expect(output).toContain("ollama pull qwen3.5:9b");
    expect(output).toContain("enter checks again");
  });

  it("says the tool check is running, then what it found", () => {
    const base = { step: "ready", provider: "ollama", model: "qwen3.5:9b" } as const;
    expect(frame({ ...base, probe: null })).toContain("Checking that the model can call tools");
    expect(frame({ ...base, probe: { nativeToolCalls: true, detail: "native tool calls confirmed (read)" } })).toContain("Tool calling works");
    expect(frame({ ...base, probe: { nativeToolCalls: false, detail: "model answered in prose" } })).toContain("falls back to a JSON protocol");
    expect(frame({ ...base, probe: { nativeToolCalls: false, detail: "probe failed: connect ECONNREFUSED" } })).toContain(
      "The model server did not answer"
    );
  });

  it("ends with prompts to try and the keys that matter", () => {
    const output = frame({ step: "ready", provider: "ollama", model: "qwen3.5:9b", probe: null });
    expect(output).toContain("summarize this repo");
    expect(output).toContain("/help");
    expect(output).toContain("enter starts the session");
  });
});
