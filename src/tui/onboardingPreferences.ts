import type { ThinkingSetting } from "../core/types.js";
import type { AgentMode } from "./types.js";

/**
 * First-run preferences collected at the end of onboarding. These map directly
 * to the runtime defaults the agent loop reads, and are persisted through
 * `savePatchPilotEnvValues` so the next launch starts in the chosen state.
 */
export type OnboardingPreferences = {
  mode: AgentMode;
  thinking: ThinkingSetting;
  stepBudget: "fixed" | "adaptive";
  subagents: boolean;
};

export const defaultOnboardingPreferences: OnboardingPreferences = {
  mode: "build",
  thinking: "auto",
  stepBudget: "adaptive",
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
    key: "thinking",
    label: "Model thinking",
    values: ["auto", "on", "off"],
  },
  {
    key: "stepBudget",
    label: "Step budget",
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

  if (key === "thinking") {
    return value === "auto"
      ? "Recommended. Each model uses whatever thinking mode it ships with."
      : value === "on"
        ? "Force thinking on. Only affects models that support it."
        : "Force thinking off for the fastest replies.";
  }

  if (key === "stepBudget") {
    return value === "adaptive"
      ? "Step count flexes with task difficulty."
      : "Step count stays fixed for predictable runs.";
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

  if (key === "stepBudget") {
    return { ...prefs, stepBudget: nextValue === "fixed" ? "fixed" : "adaptive" };
  }

  return { ...prefs, thinking: nextValue as OnboardingPreferences["thinking"] };
}

/** Env payload for `savePatchPilotEnvValues` derived from the chosen prefs. */
export function preferencesEnvValues(prefs: OnboardingPreferences): Record<string, string> {
  return {
    PATCHPILOT_DEFAULT_MODE: prefs.mode,
    PATCHPILOT_THINKING: prefs.thinking,
    PATCHPILOT_STEP_BUDGET: prefs.stepBudget,
    PATCHPILOT_SUBAGENTS: prefs.subagents ? "1" : "0",
  };
}

/** Read persisted preferences back into a typed shape, falling back safely. */
export function readOnboardingPreferences(env: NodeJS.ProcessEnv = process.env): OnboardingPreferences {
  const mode = env.PATCHPILOT_DEFAULT_MODE?.trim().toLowerCase();
  const thinking = env.PATCHPILOT_THINKING?.trim().toLowerCase();
  const stepBudget = env.PATCHPILOT_STEP_BUDGET?.trim().toLowerCase();
  const subagents = env.PATCHPILOT_SUBAGENTS?.trim().toLowerCase();

  return {
    mode: mode === "plan" || mode === "build" || mode === "bypass" ? mode : defaultOnboardingPreferences.mode,
    thinking:
      thinking === "auto" || thinking === "on" || thinking === "off" ? thinking : defaultOnboardingPreferences.thinking,
    stepBudget: stepBudget === "fixed" ? "fixed" : stepBudget === "adaptive" ? "adaptive" : defaultOnboardingPreferences.stepBudget,
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
