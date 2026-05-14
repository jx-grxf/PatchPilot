import { describe, expect, it } from "vitest";
import { filterSlashCommands } from "../src/tui/commands.js";

describe("filterSlashCommands", () => {
  it("lists all commands for slash-only input", () => {
    expect(filterSlashCommands("/").length).toBeGreaterThan(5);
  });

  it("filters commands by prefix", () => {
    expect(filterSlashCommands("/con").map((command) => command.name)).toEqual(["connect"]);
  });

  it("includes build mode shortcut", () => {
    expect(filterSlashCommands("/b").map((command) => command.name)).toContain("build");
  });

  it("filters model commands by prefix", () => {
    expect(filterSlashCommands("/model").map((command) => command.name)).toEqual(["model", "models"]);
  });

  it("includes subagent controls", () => {
    expect(filterSlashCommands("/a").map((command) => command.name)).toContain("agents");
  });

  it("includes session and diff controls", () => {
    expect(filterSlashCommands("/s").map((command) => command.name)).toContain("sessions");
    expect(filterSlashCommands("/r").map((command) => command.name)).toContain("resume");
    expect(filterSlashCommands("/d").map((command) => command.name)).toContain("diff");
  });

  it("matches aliases in the command palette", () => {
    expect(filterSlashCommands("/perms").map((command) => command.name)).toEqual(["permissions"]);
    expect(filterSlashCommands("/subagents").map((command) => command.name)).toEqual(["agents"]);
  });

  it("exposes visible categories for command palette grouping", () => {
    expect(filterSlashCommands("/status")).toEqual([
      expect.objectContaining({
        name: "status",
        category: "session"
      })
    ]);
  });
});
