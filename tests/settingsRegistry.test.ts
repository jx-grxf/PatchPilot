import { describe, expect, it } from "vitest";
import {
  cycleSettingValue,
  filterSettings,
  findSetting,
  findSettingByNameOrKey,
  formatSettingValue,
  isDefaultValue,
  readSettingValue,
  settingsForProvider,
  settingsRegistry,
  validateSettingValue
} from "../src/tui/settingsRegistry.js";

describe("the registry is complete and honest", () => {
  it("gives every setting a description and a group", () => {
    for (const setting of settingsRegistry) {
      expect(setting.description.length, `${setting.key} needs a description`).toBeGreaterThan(20);
      expect(setting.name.length, `${setting.key} needs a name`).toBeGreaterThan(2);
    }
  });

  it("uses unique environment keys", () => {
    const keys = settingsRegistry.map((setting) => setting.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("gives every choice and boolean a default it actually accepts", () => {
    for (const setting of settingsRegistry) {
      if (setting.kind.type === "choice") {
        expect(setting.kind.values, `${setting.key}`).toContain(setting.defaultValue);
      }
      if (setting.kind.type === "number") {
        const parsed = Number(setting.defaultValue);
        expect(parsed, `${setting.key}`).toBeGreaterThanOrEqual(setting.kind.min);
        expect(parsed, `${setting.key}`).toBeLessThanOrEqual(setting.kind.max);
      }
    }
  });
});

describe("hiding what would do nothing", () => {
  it("shows the Ollama endpoint only under Ollama", () => {
    expect(settingsForProvider("ollama").map((s) => s.key)).toContain("PATCHPILOT_OLLAMA_URL");
    expect(settingsForProvider("local-openai").map((s) => s.key)).not.toContain("PATCHPILOT_OLLAMA_URL");
  });

  it("shows the local server endpoint only under local-openai", () => {
    expect(settingsForProvider("local-openai").map((s) => s.key)).toContain("PATCHPILOT_LOCAL_URL");
    expect(settingsForProvider("ollama").map((s) => s.key)).not.toContain("PATCHPILOT_LOCAL_URL");
  });
});

describe("finding a setting", () => {
  it("matches the display name, the env key, and the description", () => {
    expect(filterSettings(settingsRegistry, "context").map((s) => s.key)).toContain("PATCHPILOT_NUM_CTX");
    expect(filterSettings(settingsRegistry, "NUM_CTX").map((s) => s.key)).toContain("PATCHPILOT_NUM_CTX");
    expect(filterSettings(settingsRegistry, "truncat").map((s) => s.key)).toContain("PATCHPILOT_NUM_CTX");
  });

  it("ignores case and surrounding space", () => {
    expect(filterSettings(settingsRegistry, "  TEMPERATURE  ").length).toBeGreaterThan(0);
  });

  it("returns everything for an empty query", () => {
    expect(filterSettings(settingsRegistry, "   ")).toHaveLength(settingsRegistry.length);
  });
});

describe("reading values", () => {
  const setting = findSetting("PATCHPILOT_NUM_CTX")!;

  it("falls back to the default when unset or blank", () => {
    expect(readSettingValue(setting, {})).toBe("32768");
    expect(readSettingValue(setting, { PATCHPILOT_NUM_CTX: "   " })).toBe("32768");
  });

  it("reports whether a value was changed from the default", () => {
    expect(isDefaultValue(setting, "32768")).toBe(true);
    expect(isDefaultValue(setting, "8192")).toBe(false);
  });

  it("shows booleans as on and off rather than 1 and 0", () => {
    const subagents = findSetting("PATCHPILOT_SUBAGENTS")!;
    expect(formatSettingValue(subagents, "1")).toBe("on");
    expect(formatSettingValue(subagents, "0")).toBe("off");
  });

  it("never prints a secret, only whether it is set", () => {
    const key = findSetting("PATCHPILOT_LOCAL_API_KEY")!;
    expect(formatSettingValue(key, "sk-do-not-show-me")).toBe("set");
    expect(formatSettingValue(key, "")).toBe("not set");
  });
});

describe("changing values", () => {
  it("toggles a boolean", () => {
    const setting = findSetting("PATCHPILOT_SUBAGENTS")!;
    expect(cycleSettingValue(setting, "0")).toBe("1");
    expect(cycleSettingValue(setting, "1")).toBe("0");
  });

  it("cycles a choice and wraps around", () => {
    const setting = findSetting("PATCHPILOT_DEFAULT_MODE")!;
    expect(cycleSettingValue(setting, "plan")).toBe("build");
    expect(cycleSettingValue(setting, "bypass")).toBe("plan");
  });

  it("reports that a number cannot be cycled, so the caller asks for input", () => {
    expect(cycleSettingValue(findSetting("PATCHPILOT_NUM_CTX")!, "32768")).toBeNull();
    expect(cycleSettingValue(findSetting("PATCHPILOT_MODEL")!, "x")).toBeNull();
  });
});

describe("validating typed input", () => {
  const numCtx = findSetting("PATCHPILOT_NUM_CTX")!;

  it("accepts a number in range", () => {
    expect(validateSettingValue(numCtx, "8192")).toBeNull();
  });

  it("names the setting and the range when out of bounds", () => {
    expect(validateSettingValue(numCtx, "10")).toContain("between 2048");
    expect(validateSettingValue(numCtx, "banana")).toContain("must be a number");
  });

  it("lists the permitted values for a choice", () => {
    expect(validateSettingValue(findSetting("PATCHPILOT_DEFAULT_MODE")!, "wizard")).toContain("plan, build, bypass");
  });
});

describe("finding a setting the way a user would type it", () => {
  it("accepts the full env key", () => {
    expect(findSettingByNameOrKey("PATCHPILOT_NUM_CTX")?.key).toBe("PATCHPILOT_NUM_CTX");
  });

  it("accepts the key without the prefix, which is what people type", () => {
    expect(findSettingByNameOrKey("NUM_CTX")?.key).toBe("PATCHPILOT_NUM_CTX");
    expect(findSettingByNameOrKey("num_ctx")?.key).toBe("PATCHPILOT_NUM_CTX");
  });

  it("accepts the display name, with spaces or underscores", () => {
    expect(findSettingByNameOrKey("Context window")?.key).toBe("PATCHPILOT_NUM_CTX");
    expect(findSettingByNameOrKey("context_window")?.key).toBe("PATCHPILOT_NUM_CTX");
  });

  it("returns nothing for an empty or unknown name", () => {
    expect(findSettingByNameOrKey("")).toBeUndefined();
    expect(findSettingByNameOrKey("teleporter")).toBeUndefined();
  });
});
