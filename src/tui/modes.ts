import type { AgentMode } from "./types.js";

export type ModePermissions = {
  allowWrite: boolean;
  allowShell: boolean;
};

export function initialAgentMode(permissions: ModePermissions): AgentMode {
  return permissions.allowWrite || permissions.allowShell ? "bypass" : "plan";
}

export function nextAgentMode(currentMode: AgentMode): AgentMode {
  if (currentMode === "plan") {
    return "build";
  }

  if (currentMode === "build") {
    return "bypass";
  }

  return "plan";
}

export function permissionsForMode(mode: AgentMode): ModePermissions {
  return {
    allowWrite: mode === "bypass",
    allowShell: mode === "bypass"
  };
}

export function modePermissionLabel(mode: AgentMode, permission: "write" | "shell"): string {
  if (mode === "plan") {
    return "off";
  }

  if (mode === "build") {
    return "approval";
  }

  return permission === "write" ? "on" : "on";
}

export function modeDescription(mode: AgentMode): string {
  if (mode === "plan") {
    return "plan mode is read-only";
  }

  if (mode === "build") {
    return "build mode can edit after approval";
  }

  return "build + bypass runs writes and shell without per-tool approval";
}
