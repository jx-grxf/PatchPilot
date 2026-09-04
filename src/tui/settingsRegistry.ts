import type { ModelProvider } from "../core/types.js";

/**
 * Every setting PatchPilot has, in one place.
 *
 * These were previously read straight from `process.env` at a dozen call
 * sites, each with its own parsing and its own default. Nothing could list
 * them, so nothing could show them. Declaring them once means the config
 * screen is a render of this array rather than a second copy of it, and a
 * setting that is added without a description or a sensible default is
 * visibly wrong here rather than invisibly missing there.
 */

export type SettingGroup = "provider" | "generation" | "agent" | "interface" | "experimental";

export type SettingKind =
  | { type: "boolean" }
  | { type: "choice"; values: string[] }
  | { type: "number"; min: number; max: number }
  | { type: "text"; placeholder?: string; secret?: boolean };

export type SettingDefinition = {
  /** Environment key, and the key written to ~/.patchpilot/.env. */
  key: string;
  name: string;
  description: string;
  group: SettingGroup;
  kind: SettingKind;
  defaultValue: string;
  /** Hidden when a different provider is active, because it would do nothing. */
  appliesTo?: ModelProvider;
  /**
   * Changing this only affects the next run, not one already in flight. Worth
   * saying, because silently doing nothing is the worst kind of setting.
   */
  appliesNextRun?: boolean;
};

export const settingGroupLabels: Record<SettingGroup, string> = {
  provider: "Provider",
  generation: "Generation",
  agent: "Agent",
  interface: "Interface",
  experimental: "Experimental"
};

export const settingsRegistry: SettingDefinition[] = [
  {
    key: "PATCHPILOT_PROVIDER",
    name: "Provider",
    description: "Ollama's native API, or any OpenAI-compatible local server.",
    group: "provider",
    kind: { type: "choice", values: ["ollama", "local-openai"] },
    defaultValue: "ollama"
  },
  {
    key: "PATCHPILOT_MODEL",
    name: "Model",
    description: "The model id to run. Use /models to see what each runtime serves.",
    group: "provider",
    kind: { type: "text", placeholder: "qwen2.5-coder:7b" },
    defaultValue: ""
  },
  {
    key: "PATCHPILOT_OLLAMA_URL",
    name: "Ollama endpoint",
    description: "Localhost counts as local compute; a LAN or Tailscale address is remote.",
    group: "provider",
    kind: { type: "text", placeholder: "http://127.0.0.1:11434" },
    defaultValue: "http://127.0.0.1:11434",
    appliesTo: "ollama"
  },
  {
    key: "PATCHPILOT_LOCAL_URL",
    name: "Local server endpoint",
    description: "LM Studio serves this at :1234, MLX and llama.cpp at :8080, vLLM at :8000.",
    group: "provider",
    kind: { type: "text", placeholder: "http://127.0.0.1:1234/v1" },
    defaultValue: "http://127.0.0.1:1234/v1",
    appliesTo: "local-openai"
  },
  {
    key: "PATCHPILOT_LOCAL_API_KEY",
    name: "Local server key",
    description: "Only needed by a local server configured to require one.",
    group: "provider",
    kind: { type: "text", secret: true },
    defaultValue: "",
    appliesTo: "local-openai"
  },
  {
    key: "PATCHPILOT_KEEP_ALIVE",
    name: "Keep model loaded",
    description: "How long Ollama holds the model in memory after a request.",
    group: "provider",
    kind: { type: "text", placeholder: "15m" },
    defaultValue: "15m",
    appliesTo: "ollama"
  },

  {
    key: "PATCHPILOT_NUM_CTX",
    name: "Context window",
    description:
      "Tokens the runtime is asked to load. Ollama truncates from the front when this is too small, which removes the system prompt and reads as the model forgetting its tools.",
    group: "generation",
    kind: { type: "number", min: 2048, max: 1_000_000 },
    defaultValue: "32768",
    appliesNextRun: true
  },
  {
    key: "PATCHPILOT_NUM_PREDICT",
    name: "Output budget",
    description:
      "Maximum tokens per reply. Too low truncates a file write mid-argument, which looks like the model forgetting a field.",
    group: "generation",
    kind: { type: "number", min: 512, max: 200_000 },
    defaultValue: "16384",
    appliesNextRun: true
  },
  {
    key: "PATCHPILOT_TEMPERATURE",
    name: "Temperature",
    description: "Lower is steadier. Tool calling wants steady far more than it wants creative.",
    group: "generation",
    kind: { type: "number", min: 0, max: 2 },
    defaultValue: "0.2",
    appliesNextRun: true
  },
  {
    key: "PATCHPILOT_TOP_P",
    name: "Top-p",
    description: "Nucleus sampling cutoff.",
    group: "generation",
    kind: { type: "number", min: 0, max: 1 },
    defaultValue: "0.9",
    appliesNextRun: true
  },
  {
    key: "PATCHPILOT_TOP_K",
    name: "Top-k",
    description: "Candidate cutoff. 0 disables it.",
    group: "generation",
    kind: { type: "number", min: 0, max: 200 },
    defaultValue: "40",
    appliesNextRun: true
  },
  {
    key: "PATCHPILOT_REPEAT_PENALTY",
    name: "Repeat penalty",
    description:
      "Sent as 1.0, overriding Ollama's 1.1: the penalty branches on raw logit sign while softmax is shift-invariant, so its zero point is arbitrary — and structured output, which must repeat braces and field names, is what suffers.",
    group: "generation",
    kind: { type: "number", min: 0.5, max: 2 },
    defaultValue: "1.0",
    appliesNextRun: true
  },

  {
    key: "PATCHPILOT_DEFAULT_MODE",
    name: "Default mode",
    description: "plan is read-only; build asks before writing; bypass does not ask.",
    group: "agent",
    kind: { type: "choice", values: ["plan", "build", "bypass"] },
    defaultValue: "build"
  },
  {
    key: "PATCHPILOT_SUBAGENTS",
    name: "Subagents",
    description: "Let the agent delegate exploration to a child with its own context.",
    group: "agent",
    kind: { type: "boolean" },
    defaultValue: "0"
  },

  {
    key: "PATCHPILOT_UI_THEME",
    name: "Shell",
    description: "flow renders into the terminal's own scrollback, so selection and copy work.",
    group: "interface",
    kind: { type: "choice", values: ["flow", "new", "legacy"] },
    defaultValue: "flow"
  },
  {
    key: "PATCHPILOT_REDUCE_MOTION",
    name: "Reduce motion",
    description: "Hold spinners and bars still. Motion already stops when output is piped rather than shown.",
    group: "interface",
    kind: { type: "boolean" },
    defaultValue: "0"
  },
  {
    key: "PATCHPILOT_UPDATE_CHECK",
    name: "Check for updates",
    description: "Look for a newer PatchPilot release on launch.",
    group: "interface",
    kind: { type: "boolean" },
    defaultValue: "1"
  },

  {
    key: "PATCHPILOT_EXPERIMENTAL_FILE_ANALYSIS",
    name: "File analysis",
    description: "Read PDFs, images and documents outside the workspace.",
    group: "experimental",
    kind: { type: "boolean" },
    defaultValue: "0"
  },
  {
    key: "PATCHPILOT_EXPERIMENTAL_MEMORY",
    name: "Memory",
    description: "Durable notes the agent can search across sessions.",
    group: "experimental",
    kind: { type: "boolean" },
    defaultValue: "0"
  },
  {
    key: "PATCHPILOT_EXPERIMENTAL_SHELL_METACHARACTERS",
    name: "Shell metacharacters",
    description: "Allow pipes and && in bash. Redirects and background jobs still need approval.",
    group: "experimental",
    kind: { type: "boolean" },
    defaultValue: "0"
  },
  {
    key: "PATCHPILOT_DEBUG",
    name: "Debug output",
    description: "Include underlying errors in messages that normally summarise them.",
    group: "experimental",
    kind: { type: "boolean" },
    defaultValue: "0"
  }
];

/** Settings that would do nothing under the active provider are hidden. */
export function settingsForProvider(provider: ModelProvider): SettingDefinition[] {
  return settingsRegistry.filter((setting) => !setting.appliesTo || setting.appliesTo === provider);
}

/**
 * Resolves what a user would actually type: the env key with or without the
 * PATCHPILOT_ prefix, or the display name. Requiring the full key would make
 * the command unusable without first reading the config screen.
 */
export function findSettingByNameOrKey(input: string): SettingDefinition | undefined {
  const normalized = input.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!normalized) {
    return undefined;
  }

  return settingsRegistry.find(
    (setting) =>
      setting.key.toLowerCase() === normalized ||
      setting.key.toLowerCase() === `patchpilot_${normalized}` ||
      setting.name.toLowerCase().replace(/[\s-]+/g, "_") === normalized
  );
}

export function findSetting(key: string): SettingDefinition | undefined {
  return settingsRegistry.find((setting) => setting.key === key);
}

/**
 * Matches a query against name, key and description, so both "context" and
 * "NUM_CTX" find the same row.
 */
export function filterSettings(settings: SettingDefinition[], query: string): SettingDefinition[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return settings;
  }

  return settings.filter((setting) =>
    [setting.name, setting.key, setting.description].some((field) => field.toLowerCase().includes(normalized))
  );
}

/** The effective value: what is set, or the default. */
export function readSettingValue(setting: SettingDefinition, env: NodeJS.ProcessEnv = process.env): string {
  return env[setting.key]?.trim() || setting.defaultValue;
}

export function isDefaultValue(setting: SettingDefinition, value: string): boolean {
  return value === setting.defaultValue;
}

/** How a value reads in the list: booleans as on/off, secrets never shown. */
export function formatSettingValue(setting: SettingDefinition, value: string): string {
  if (setting.kind.type === "boolean") {
    return isTruthy(value) ? "on" : "off";
  }

  if (setting.kind.type === "text" && setting.kind.secret) {
    return value ? "set" : "not set";
  }

  return value || "not set";
}

export function isTruthy(value: string): boolean {
  return ["1", "true", "yes", "on", "enabled"].includes(value.trim().toLowerCase());
}

/**
 * The next value when a row is toggled or cycled. Numbers and free text cannot
 * be cycled, so they report that they need typing instead.
 */
export function cycleSettingValue(setting: SettingDefinition, current: string): string | null {
  if (setting.kind.type === "boolean") {
    return isTruthy(current) ? "0" : "1";
  }

  if (setting.kind.type === "choice") {
    const index = setting.kind.values.indexOf(current);
    return setting.kind.values[(index + 1) % setting.kind.values.length] ?? setting.kind.values[0] ?? current;
  }

  return null;
}

/** Validates typed input, returning the message to show when it is rejected. */
export function validateSettingValue(setting: SettingDefinition, value: string): string | null {
  if (setting.kind.type === "number") {
    const parsed = Number(value.trim());
    if (!Number.isFinite(parsed)) {
      return `${setting.name} must be a number.`;
    }
    if (parsed < setting.kind.min || parsed > setting.kind.max) {
      return `${setting.name} must be between ${setting.kind.min} and ${setting.kind.max}.`;
    }
  }

  if (setting.kind.type === "choice" && !setting.kind.values.includes(value.trim())) {
    return `${setting.name} must be one of: ${setting.kind.values.join(", ")}.`;
  }

  return null;
}
