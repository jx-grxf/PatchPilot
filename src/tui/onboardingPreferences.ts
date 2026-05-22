import type { ReasoningSetting } from "../core/reasoning.js";
import type { AgentMode } from "./types.js";

/**
 * First-run preferences collected at the end of onboarding. These map directly
 * to the runtime defaults the agent loop reads, and are persisted through
 * `savePatchPilotEnvValues` so the next launch starts in the chosen state.
 */
export type OnboardingPreferences = {
  mode: AgentMode;
  reasoning: ReasoningSetting | "adaptive";
  thinking: "fixed" | "adaptive";
  subagents: boolean;
};

export const defaultOnboardingPreferences: OnboardingPreferences = {
  mode: "build",
  reasoning: "medium",
  thinking: "adaptive",
  subagents: false,
};

/** A single tunable row in the preferences step. */
export type PreferenceRow = {
  key: keyof OnboardingPreferences;
  label: string;
  /** Cycle of selectable values for this row, in display order. */
  values: string[];
};

export const preferenceRows: PreferenceRow[] = [
  {
    key: "mode",
    label: "Agent mode",
    values: ["plan", "build"],
  },
  {
    key: "reasoning",
    label: "Reasoning effort",
    values: ["none", "low", "medium", "high", "xhigh", "adaptive"],
  },
  {
    key: "thinking",
    label: "Thinking budget",
    values: ["fixed", "adaptive"],
  },
  {
    key: "subagents",
    label: "Planner / Reviewer subagents",
    values: ["off", "on"],
  },
];

/** Human-friendly one-liner for the currently selected value of a row. */
export function describePreferenceValue(key: keyof OnboardingPreferences, value: string): string {
  if (key === "mode") {
    return value === "plan"
      ? "Read-only. The agent inspects and plans, never writes."
      : value === "build"
        ? "Recommended. Writes and shell run behind per-action approval prompts."
        : "Use /mode bypass after setup when you want trusted-workspace bypass.";
  }

  if (key === "reasoning") {
    return value === "none"
      ? "Fastest, cheapest. No extra reasoning budget."
      : value === "adaptive"
        ? "The agent scales reasoning to the task. Good general default."
        : `Fixed ${value} reasoning budget on every step.`;
  }

  if (key === "thinking") {
    return value === "adaptive"
      ? "Thinking budget flexes with task difficulty."
      : "Thinking budget stays fixed for predictable latency.";
  }

  return value === "on"
    ? "Advisory planner and reviewer run before the main loop. Slower, higher quality."
    : "Skip advisors for faster, leaner local runs.";
}

/** Current displayed value for a preference row given the working prefs. */
export function preferenceValueString(prefs: OnboardingPreferences, key: keyof OnboardingPreferences): string {
  if (key === "subagents") {
    return prefs.subagents ? "on" : "off";
  }

  return String(prefs[key]);
}

/** Cycle a row's value forward (+1) or backward (-1), wrapping around. */
export function cyclePreference(
  prefs: OnboardingPreferences,
  key: keyof OnboardingPreferences,
  direction: 1 | -1
): OnboardingPreferences {
  const row = preferenceRows.find((candidate) => candidate.key === key);
  if (!row) {
    return prefs;
  }

  const current = preferenceValueString(prefs, key);
  const currentIndex = Math.max(0, row.values.indexOf(current));
  const nextIndex = (currentIndex + direction + row.values.length) % row.values.length;
  const nextValue = row.values[nextIndex] ?? row.values[0] ?? current;

  if (key === "subagents") {
    return { ...prefs, subagents: nextValue === "on" };
  }

  if (key === "mode") {
    return { ...prefs, mode: nextValue as AgentMode };
  }

  if (key === "thinking") {
    return { ...prefs, thinking: nextValue === "adaptive" ? "adaptive" : "fixed" };
  }

  return { ...prefs, reasoning: nextValue as OnboardingPreferences["reasoning"] };
}

/** Env payload for `savePatchPilotEnvValues` derived from the chosen prefs. */
export function preferencesEnvValues(prefs: OnboardingPreferences): Record<string, string> {
  return {
    PATCHPILOT_DEFAULT_MODE: prefs.mode,
    PATCHPILOT_REASONING_EFFORT: prefs.reasoning,
    PATCHPILOT_THINKING_MODE: prefs.thinking,
    PATCHPILOT_SUBAGENTS: prefs.subagents ? "1" : "0",
  };
}

/** Read persisted preferences back into a typed shape, falling back safely. */
export function readOnboardingPreferences(env: NodeJS.ProcessEnv = process.env): OnboardingPreferences {
  const mode = env.PATCHPILOT_DEFAULT_MODE?.trim().toLowerCase();
  const reasoning = env.PATCHPILOT_REASONING_EFFORT?.trim().toLowerCase();
  const thinking = env.PATCHPILOT_THINKING_MODE?.trim().toLowerCase();
  const subagents = env.PATCHPILOT_SUBAGENTS?.trim().toLowerCase();

  return {
    mode: mode === "plan" || mode === "build" || mode === "bypass" ? mode : defaultOnboardingPreferences.mode,
    reasoning:
      reasoning === "none" ||
      reasoning === "low" ||
      reasoning === "medium" ||
      reasoning === "high" ||
      reasoning === "xhigh" ||
      reasoning === "adaptive"
        ? reasoning
        : defaultOnboardingPreferences.reasoning,
    thinking: thinking === "fixed" ? "fixed" : thinking === "adaptive" ? "adaptive" : defaultOnboardingPreferences.thinking,
    subagents: subagents === undefined ? defaultOnboardingPreferences.subagents : ["1", "true", "yes", "on", "enabled"].includes(subagents),
  };
}

/** Mode string maps to runtime write/shell permissions for the agent loop. */
export function modePermissions(mode: AgentMode): { allowWrite: boolean; allowShell: boolean } {
  return {
    allowWrite: mode === "bypass",
    allowShell: mode === "bypass",
  };
}
