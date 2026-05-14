import type { AgentToolName, AgentWorkState, SubagentRole, ToolCategory } from "../core/types.js";

export type AgentMode = "plan" | "build";

export type LogTone = "muted" | "normal" | "success" | "warning" | "danger" | "accent";

export type TranscriptBlockKind = "user" | "assistant" | "tool" | "diff" | "approval" | "error" | "final" | "status";

export type LogLine = {
  id: number;
  kind: TranscriptBlockKind;
  tone: LogTone;
  label: string;
  text: string;
  detail?: string;
  workState?: AgentWorkState;
  tool?: AgentToolName;
  toolCallId?: string;
  category?: ToolCategory;
  preview?: string;
};

export type LogLineInput = Omit<LogLine, "id" | "kind"> & {
  kind?: TranscriptBlockKind;
};

export type AppendLine = (line: LogLineInput) => void;

export type AdvisorNote = {
  role: SubagentRole;
  message: string;
};

export const maxTranscriptLines = 300;
