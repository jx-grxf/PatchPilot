import type { ToolPermission } from "../core/types.js";
import type { AgentMode } from "./types.js";

export type ModePermissions = {
  allowWrite: boolean;
  allowShell: boolean;
};

/**
 * CLI grants win; otherwise the saved default mode applies. A saved bypass
 * starts in build, because bypass is only ever entered through the visible
 * confirmation in the TUI.
 */
export function initialAgentMode(permissions: ModePermissions, defaultMode?: string): AgentMode {
  if (permissions.allowWrite && permissions.allowShell) {
    return "bypass";
  }

  if (permissions.allowWrite || permissions.allowShell) {
    return "build";
  }

  const saved = defaultMode?.trim().toLowerCase();
  return saved === "build" || saved === "bypass" ? "build" : "plan";
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

export function modePermissionLabel(mode: AgentMode, permission: "write" | "shell", permissions?: ModePermissions): string {
  if (permissions?.[permission === "write" ? "allowWrite" : "allowShell"]) {
    return "on";
  }

  if (mode === "plan") {
    return "off";
  }

  if (mode === "build") {
    return "approval";
  }

  return permission === "write" ? "on" : "on";
}

export function shouldBypassApproval(options: {
  mode: AgentMode;
  permission: Exclude<ToolPermission, "none">;
  permissions: ModePermissions;
  allowExternalFileAnalysis: boolean;
}): boolean {
  if (options.mode !== "bypass") {
    return false;
  }

  if (options.permission === "write") {
    return options.permissions.allowWrite;
  }

  if (options.permission === "shell" || options.permission === "network") {
    return options.permissions.allowShell;
  }

  return options.permission === "external_file" && options.allowExternalFileAnalysis;
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
