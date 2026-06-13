import { describe, expect, it } from "vitest";
import { computeComposerLayout } from "../src/tui/layout.js";
import { computeExperimentalLayout, windowRows } from "../src/tui/experimental/layout.js";

const terminalSizes: Array<[number, number]> = [
  [80, 24],
  [120, 40],
  [207, 47],
];

describe("computeExperimentalLayout", () => {
  it.each(terminalSizes)("fills the screen exactly with no overlap at %ix%i", (columns, rows) => {
    const layout = computeExperimentalLayout({
      rows,
      columns,
      composerInput: "",
      paletteItemCount: 0,
      approvalActive: false,
    });

    const sum = layout.headerHeight + layout.transcriptHeight + layout.composerHeight + layout.footerHeight;
    expect(sum).toBe(layout.rootHeight);
    expect(layout.transcriptHeight).toBeGreaterThanOrEqual(3);
    expect(layout.transcriptWidth).toBeGreaterThan(0);
  });

  it.each(terminalSizes)("keeps a usable transcript with an approval panel open at %ix%i", (columns, rows) => {
    const layout = computeExperimentalLayout({
      rows,
      columns,
      composerInput: "",
      paletteItemCount: 0,
      approvalActive: true,
    });

    expect(layout.approvalHeight).toBeGreaterThan(0);
    expect(layout.transcriptHeight).toBeGreaterThanOrEqual(3);
    const sum =
      layout.headerHeight + layout.transcriptHeight + layout.composerHeight + layout.approvalHeight + layout.footerHeight;
    expect(sum).toBeGreaterThanOrEqual(layout.rootHeight);
  });

  it("returns all approval space to the transcript when no prompt is visible", () => {
    const withoutApproval = computeExperimentalLayout({ rows: 47, columns: 208, composerInput: "", paletteItemCount: 0, approvalActive: false });
    const withApproval = computeExperimentalLayout({ rows: 47, columns: 208, composerInput: "", paletteItemCount: 0, approvalActive: true });

    expect(withoutApproval.approvalHeight).toBe(0);
    expect(withoutApproval.transcriptHeight - withApproval.transcriptHeight).toBe(withApproval.approvalHeight);
  });

  it.each(terminalSizes)("keeps the composer bounded to 3-7 editor rows at %ix%i", (columns, rows) => {
    const longInput = "investigate the repository ".repeat(60);
    const layout = computeExperimentalLayout({
      rows,
      columns,
      composerInput: longInput,
      paletteItemCount: 0,
      approvalActive: false,
    });

    // composer = editor rows (3-7) + status row + rounded border (2).
    expect(layout.composerHeight).toBeGreaterThanOrEqual(5);
    expect(layout.composerHeight).toBeLessThanOrEqual(9);
  });

  it("clamps tiny terminals to the 80x24 minimum", () => {
    const layout = computeExperimentalLayout({
      rows: 5,
      columns: 10,
      composerInput: "",
      paletteItemCount: 0,
      approvalActive: false,
    });

    expect(layout.rootHeight).toBe(24);
    expect(layout.rootWidth).toBe(80);
  });

  it("reserves palette space only when there are items", () => {
    const empty = computeExperimentalLayout({ rows: 40, columns: 120, composerInput: "", paletteItemCount: 0, approvalActive: false });
    const filled = computeExperimentalLayout({ rows: 40, columns: 120, composerInput: "", paletteItemCount: 6, approvalActive: false });
    expect(empty.paletteHeight).toBe(0);
    expect(filled.paletteHeight).toBeGreaterThan(0);
  });
});

describe("computeExperimentalLayout under overlay pressure", () => {
  const overlaySizes: Array<[number, number]> = [
    [80, 24],
    [100, 30],
    [120, 40],
  ];

  it.each(overlaySizes)(
    "never clips the critical UI when every overlay is active at %ix%i",
    (columns, rows) => {
      const layout = computeExperimentalLayout({
        rows,
        columns,
        composerInput: "investigate the repository ".repeat(60),
        paletteItemCount: 8,
        approvalActive: true,
        todoCount: 6,
        hasArtifacts: true,
      });

      // Critical safety surfaces keep their full reserved height.
      expect(layout.headerHeight).toBe(4);
      expect(layout.footerHeight).toBe(1);
      expect(layout.approvalHeight).toBeGreaterThan(0);
      expect(layout.composerHeight).toBeGreaterThanOrEqual(5);

      // Critical UI always fits inside the terminal on its own.
      const critical =
        layout.headerHeight + layout.composerHeight + layout.approvalHeight + layout.footerHeight;
      expect(critical).toBeLessThanOrEqual(layout.rootHeight);

      // Nothing is allocated past the bottom of the terminal.
      const sum =
        layout.headerHeight +
        layout.artifactsHeight +
        layout.transcriptHeight +
        layout.todoDockHeight +
        layout.approvalHeight +
        layout.paletteHeight +
        layout.composerHeight +
        layout.footerHeight;
      expect(sum).toBe(layout.rootHeight);

      // The transcript is never given a negative or zero height.
      expect(layout.transcriptHeight).toBeGreaterThanOrEqual(1);
    },
  );

  it("folds secondary panels before shrinking the transcript at 80x24", () => {
    const bare = computeExperimentalLayout({
      rows: 24,
      columns: 80,
      composerInput: "",
      paletteItemCount: 0,
      approvalActive: false,
    });
    const pressured = computeExperimentalLayout({
      rows: 24,
      columns: 80,
      composerInput: "",
      paletteItemCount: 8,
      approvalActive: true,
      todoCount: 6,
      hasArtifacts: true,
    });

    // Under pressure the secondary panels yield rather than the critical UI.
    const secondary = pressured.paletteHeight + pressured.todoDockHeight + pressured.artifactsHeight;
    expect(secondary).toBeLessThan(bare.transcriptHeight);
  });
});

describe("windowRows", () => {
  it("anchors short content to the top with no overflow", () => {
    const window = windowRows(4, 20, 0);
    expect(window).toMatchObject({ start: 0, end: 4, anchored: "top", hasOverflow: false });
  });

  it("anchors overflowing content to the bottom", () => {
    const window = windowRows(100, 20, 0);
    expect(window.anchored).toBe("bottom");
    expect(window.end).toBe(100);
    expect(window.end - window.start).toBe(20);
  });

  it("walks the window upward as the scroll offset grows and clamps it", () => {
    const scrolled = windowRows(100, 20, 30);
    expect(scrolled.end).toBe(70);
    expect(scrolled.clampedOffset).toBe(30);

    const overscrolled = windowRows(100, 20, 9999);
    expect(overscrolled.clampedOffset).toBe(80);
    expect(overscrolled.start).toBe(0);
  });
});

describe("composer never clips long prompts", () => {
  it.each(terminalSizes)("keeps the newest draft text visible at %i columns", (columns) => {
    const transcriptWidth = computeExperimentalLayout({
      rows: 40,
      columns,
      composerInput: "",
      paletteItemCount: 0,
      approvalActive: false,
    }).transcriptWidth;
    const input = `${"please inspect the repository and summarise the architecture risks ".repeat(20)}THE_VISIBLE_END`;
    const layout = computeComposerLayout({ input, width: transcriptWidth, promptWidth: 2, minHeight: 3, maxHeight: 7 });

    expect(layout.height).toBeGreaterThanOrEqual(3);
    expect(layout.height).toBeLessThanOrEqual(7);
    expect(layout.visibleRows.length).toBe(layout.editorRows);
    expect(layout.visibleRows.at(-1)).toContain("THE_VISIBLE_END");
    expect(layout.hiddenRows).toBeGreaterThan(0);
  });
});
