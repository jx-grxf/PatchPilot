import { describe, expect, it } from "vitest";
import { filterSlashCommands } from "../src/tui/commands.js";

describe("filterSlashCommands", () => {
  it("lists all commands for slash-only input", () => {
    expect(filterSlashCommands("/").length).toBeGreaterThan(5);
  });

  it("filters commands by prefix", () => {
    expect(filterSlashCommands("/con").map((command) => command.name)).toEqual(["connect"]);
  });
});
