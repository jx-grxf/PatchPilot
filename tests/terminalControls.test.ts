import { describe, expect, it } from "vitest";
import { stripTerminalControls } from "../src/tui/format.js";

const esc = String.fromCharCode(27);
const bel = String.fromCharCode(7);

describe("stripTerminalControls", () => {
  it("removes OSC sequences such as a clipboard write or title change", () => {
    expect(stripTerminalControls(`a${esc}]52;c;ZXZpbA==${bel}b`)).toBe("ab");
    expect(stripTerminalControls(`a${esc}]0;title${esc}\\b`)).toBe("ab");
  });

  it("removes CSI cursor and erase sequences", () => {
    expect(stripTerminalControls(`ok${esc}[2J${esc}[1;1Hfake`)).toBe("okfake");
    expect(stripTerminalControls(`${String.fromCharCode(0x9b)}31mred`)).toBe("red");
  });

  it("keeps newlines and tabs and drops other control characters", () => {
    expect(stripTerminalControls(`line1\n\tline2${String.fromCharCode(8)}${String.fromCharCode(0x7f)}`)).toBe("line1\n\tline2");
  });

  it("leaves ordinary text alone", () => {
    expect(stripTerminalControls("● Write(index.html) ⎿ ü → ✓")).toBe("● Write(index.html) ⎿ ü → ✓");
  });
});
