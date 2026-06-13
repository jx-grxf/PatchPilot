import { describe, expect, it } from "vitest";
import { buildShellRows } from "../src/tui/experimental/transcriptRows.js";

describe("buildShellRows", () => {
  it("does not count zero-height separator rows as visible chat space", () => {
    const rows = buildShellRows(
      [
        {
          id: 1,
          kind: "tool",
          tone: "success",
          label: "write_file",
          text: "updated layout",
          detail: "src/tui/layout.ts",
          workState: "editing"
        }
      ],
      120
    );

    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.symbol || row.label || row.text)).toBe(true);
  });
});
