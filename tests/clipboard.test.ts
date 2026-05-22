import { describe, expect, it } from "vitest";
import { clipboardImageHint, clipboardListingHasImage } from "../src/core/clipboard.js";

describe("clipboardListingHasImage", () => {
  it("detects macOS clipboard-info image class codes", () => {
    expect(clipboardListingHasImage("«class PNGf», 91234, «class furl»")).toBe(true);
    expect(clipboardListingHasImage("«class TIFF», 5120")).toBe(true);
    expect(clipboardListingHasImage("«class 8BPS», 4096")).toBe(true);
  });

  it("detects Linux / Windows image MIME targets", () => {
    expect(clipboardListingHasImage("TARGETS\nimage/png\ntext/html")).toBe(true);
    expect(clipboardListingHasImage("image/jpeg")).toBe(true);
  });

  it("returns false for text-only clipboards", () => {
    expect(clipboardListingHasImage("«class utf8», 42")).toBe(false);
    expect(clipboardListingHasImage("TARGETS\ntext/plain\nUTF8_STRING")).toBe(false);
    expect(clipboardListingHasImage("")).toBe(false);
  });
});

describe("clipboardImageHint", () => {
  it("always points at Ctrl+V", () => {
    expect(clipboardImageHint("linux")).toContain("Ctrl+V");
    expect(clipboardImageHint("win32")).toContain("Ctrl+V");
  });

  it("warns macOS users that the terminal eats Cmd+V", () => {
    expect(clipboardImageHint("darwin")).toContain("⌘V");
  });
});
