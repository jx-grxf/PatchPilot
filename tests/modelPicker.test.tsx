import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { ModelPicker } from "../src/tui/components/ModelPicker.js";

const models = Array.from({ length: 12 }, (_, index) => `model-${index}`);

function frame(props: Partial<React.ComponentProps<typeof ModelPicker>> = {}): string {
  const { lastFrame } = render(
    <ModelPicker
      current="model-0"
      matches={models}
      query=""
      index={0}
      formatLabel={(model) => model}
      formatDescription={() => ""}
      {...props}
    />
  );
  return lastFrame() ?? "";
}

describe("ModelPicker", () => {
  it("marks the current model and the selection", () => {
    const output = frame({ index: 1 });
    expect(output).toContain("✓ current");
    expect(output).toMatch(/› model-1/);
  });

  it("windows a long list around the selection", () => {
    const output = frame({ index: 11 });
    expect(output).toContain("model-11");
    expect(output).not.toContain("model-0 ");
    expect(output).toContain("of 12");
  });

  it("says when nothing matches", () => {
    expect(frame({ matches: [], query: "zzz" })).toContain('No model matches "zzz"');
  });
});
