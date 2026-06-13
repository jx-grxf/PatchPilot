import { afterEach, describe, expect, it, vi } from "vitest";
import { checkForPatchPilotUpdate, updateCommand } from "../src/core/updateCheck.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("updateCheck", () => {
  it("detects newer npm versions and returns the global npm update command", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ version: "1.2.0" }), {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      })
    );

    await expect(checkForPatchPilotUpdate("1.1.0")).resolves.toEqual({
      available: true,
      currentVersion: "1.1.0",
      latestVersion: "1.2.0",
      source: "npm",
      command: updateCommand("1.2.0")
    });
  });

  it("falls back to GitHub releases when npm lookup fails", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ tag_name: "v1.3.0" }), {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        })
      );

    await expect(checkForPatchPilotUpdate("1.1.0")).resolves.toMatchObject({
      available: true,
      latestVersion: "1.3.0",
      source: "github"
    });
  });

  it("stays quiet when no newer version exists", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ version: "1.1.0" }), {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      })
    );

    await expect(checkForPatchPilotUpdate("1.1.0")).resolves.toEqual({
      available: false,
      currentVersion: "1.1.0",
      latestVersion: "1.1.0",
      source: "npm"
    });
  });

  it("builds an exact npm install command for the selected release", () => {
    expect(updateCommand("1.2.2")).toBe("npm install -g @jx-grxf/patchpilot@1.2.2");
  });
});
