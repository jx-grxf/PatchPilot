import { describe, expect, it } from "vitest";
import { filterSlashCommands, formatCommandDetail, formatCommandHelp } from "../src/tui/commands.js";

describe("filterSlashCommands", () => {
  it("lists all commands for slash-only input", () => {
    expect(filterSlashCommands("/").length).toBeGreaterThan(5);
  });

  it("filters commands by prefix", () => {
    expect(filterSlashCommands("/con").map((command) => command.name)).toContain("connect");
    expect(filterSlashCommands("/con").map((command) => command.name)).toContain("context");
  });

  it("includes build mode shortcut", () => {
    expect(filterSlashCommands("/b").map((command) => command.name)).toContain("build");
    expect(filterSlashCommands("/b").map((command) => command.name)).toContain("bypass");
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
    expect(filterSlashCommands("/ctx").map((command) => command.name)).toContain("context");
    expect(filterSlashCommands("/compress").map((command) => command.name)).toContain("compact");
  });

  it("filters context and compact subcommands by typed arguments", () => {
    expect(filterSlashCommands("/context f").map((command) => command.name)).toEqual(["context files"]);
    expect(filterSlashCommands("/context p").map((command) => command.name)).toEqual(["context pins"]);
    expect(filterSlashCommands("/compact a").map((command) => command.name)).toEqual(["compact auto"]);
    expect(filterSlashCommands("/compact r").map((command) => command.name)).toEqual(["compact reset"]);
  });

  it("exposes context and compact commands in help output", () => {
    const detail = formatCommandDetail();

    expect(detail).toContain("/context show|files|pins|clear|export");
    expect(detail).toContain("/context files");
    expect(detail).toContain("/compact now|auto|reset");
    expect(detail).toContain("/compact auto [on|off]");
    expect(formatCommandHelp("context files")).toContain("path-backed context");
    expect(formatCommandHelp("/compact auto")).toContain("automatic ContextStore compaction");
    expect(formatCommandHelp("ctx export")).toContain("snapshot JSON");
  });

  it("exposes visible categories for command palette grouping", () => {
    expect(filterSlashCommands("/status")).toEqual([
      expect.objectContaining({
        name: "status",
        category: "session"
      })
    ]);
  });

  it("includes detailed usage counters", () => {
    expect(filterSlashCommands("/usage")).toEqual([
      expect.objectContaining({
        name: "usage",
        category: "session"
      })
    ]);
  });

  it("includes the manual update checker", () => {
    expect(filterSlashCommands("/update")).toEqual([
      expect.objectContaining({
        name: "update",
        category: "utility"
      })
    ]);
  });
  it("includes the session recap command and summary alias", () => {
    expect(filterSlashCommands("/recap")).toEqual([
      expect.objectContaining({
        name: "recap",
        category: "session"
      })
    ]);
    expect(filterSlashCommands("/summary").map((command) => command.name)).toEqual(["recap"]);
  });
});
