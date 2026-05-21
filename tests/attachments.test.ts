import { describe, expect, it } from "vitest";
import {
  attachmentKindForPath,
  attachmentLabel,
  looksLikeAttachmentPath,
  sanitizePastedText,
  stripQuotes,
} from "../src/tui/experimental/attachments.js";
import { estimateGeminiCost, formatSavedCost, geminiPriceFor } from "../src/tui/experimental/geminiPricing.js";

describe("attachment classification", () => {
  it("classifies known document extensions", () => {
    expect(attachmentKindForPath("/a/b/photo.PNG")).toBe("image");
    expect(attachmentKindForPath("~/docs/report.pdf")).toBe("pdf");
    expect(attachmentKindForPath("./spec.docx")).toBe("docx");
    expect(attachmentKindForPath("notes.md")).toBe("text");
    expect(attachmentKindForPath("/src/index.ts")).toBeNull();
  });

  it("detects pasted file paths but not prose", () => {
    expect(looksLikeAttachmentPath("/Users/x/Downloads/shot.png")).toBe(true);
    expect(looksLikeAttachmentPath("~/d/report.pdf")).toBe(true);
    expect(looksLikeAttachmentPath('"/Users/x/my file.png"')).toBe(true);
    expect(looksLikeAttachmentPath("please look at the image")).toBe(false);
    expect(looksLikeAttachmentPath("/Users/x/my file.png")).toBe(false);
    expect(looksLikeAttachmentPath("report.pdf")).toBe(false);
  });

  it("strips surrounding quotes", () => {
    expect(stripQuotes('"/a/b.png"')).toBe("/a/b.png");
    expect(stripQuotes("'/a/b.png'")).toBe("/a/b.png");
    expect(stripQuotes("/a/b.png")).toBe("/a/b.png");
  });

  it("labels attachment chips per kind", () => {
    expect(attachmentLabel("image", 1)).toBe("Image #1");
    expect(attachmentLabel("pdf", 3)).toBe("PDF #3");
    expect(attachmentLabel("docx", 2)).toBe("DOCX #2");
  });

  it("normalizes newlines and drops control characters when pasting", () => {
    expect(sanitizePastedText("a\r\nb\rc")).toBe("a\nb\nc");
    expect(sanitizePastedText("keep\tthis\nand\nthis")).toBe("keep\tthis\nand\nthis");
    const withControls = `strip${String.fromCharCode(7)}${String.fromCharCode(0)}me`;
    expect(sanitizePastedText(withControls)).toBe("stripme");
  });
});

describe("gemini pricing / saved cost", () => {
  it("resolves prices per model tier", () => {
    expect(geminiPriceFor("gemini-2.5-pro")).toEqual({ inputPerMillion: 1.25, outputPerMillion: 10 });
    expect(geminiPriceFor("gemini-2.5-flash")).toEqual({ inputPerMillion: 0.3, outputPerMillion: 2.5 });
    expect(geminiPriceFor("gemini-2.5-flash-lite")).toEqual({ inputPerMillion: 0.1, outputPerMillion: 0.4 });
    expect(geminiPriceFor("auto")).toEqual({ inputPerMillion: 0.3, outputPerMillion: 2.5 });
  });

  it("estimates the paid-API cost the free wrapper saved", () => {
    expect(estimateGeminiCost(1_000_000, 1_000_000, "gemini-2.5-pro")).toBeCloseTo(11.25, 5);
    expect(estimateGeminiCost(0, 0, "gemini-2.5-pro")).toBe(0);
  });

  it("formats the saved-cost figure", () => {
    expect(formatSavedCost(0)).toBe("$0.00");
    expect(formatSavedCost(0.004)).toBe("<$0.01");
    expect(formatSavedCost(2.5)).toBe("$2.50");
  });
});
