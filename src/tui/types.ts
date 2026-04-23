import type { SubagentRole } from "../core/types.js";

export type AgentMode = "plan" | "build";

export type LogTone = "muted" | "normal" | "success" | "warning" | "danger" | "accent";

export type LogLine = {
  id: number;
  tone: LogTone;
  label: string;
  text: string;
  detail?: string;
};

export type AppendLine = (line: Omit<LogLine, "id">) => void;

export type AdvisorNote = {
  role: SubagentRole;
  message: string;
};

export const maxTranscriptLines = 22;
