import type { ModelTelemetry, SessionTelemetry } from "../core/types.js";
import type { GpuStats } from "./systemStats.js";
import type { LogTone } from "./types.js";

export type InkColor = "gray" | "white" | "green" | "yellow" | "red" | "cyan";
export type StatusColor = "gray" | "green" | "yellow" | "red" | "cyan";

export function getModelHint(model: string): { text: string; color: "green" | "yellow" } {
  const normalizedModel = model.toLowerCase();
  if (/\bcoder\b|qwen.*coder|deepseek-coder|codestral|starcoder|dracarys/i.test(normalizedModel)) {
    return {
      text: "coding model ready",
      color: "green"
    };
  }

  if (
    /(llama-?3(\.\d+)?|nemotron|deepseek|qwen|mixtral|mistral|gemini|claude|gpt|o\d)/i.test(normalizedModel) &&
    (/\b(49b|70b|72b|90b|120b|405b|large|pro|super|ultra|sonnet|opus|reason)\b/i.test(normalizedModel) || /gpt-[45]|claude|gemini-2\.5-pro|o\d/i.test(normalizedModel))
  ) {
    return {
      text: "agent-capable model selected",
      color: "green"
    };
  }

  return {
    text: "general model selected; coding reliability may be weak",
    color: "yellow"
  };
}

export function formatOllamaHost(value: string): string {
  if (!value) {
    return "not connected";
  }

  try {
    const url = new URL(value);
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
      return "local";
    }

    return url.host;
  } catch {
    return value;
  }
}

export function formatTokens(telemetry: ModelTelemetry | null): string {
  if (!telemetry) {
    return "-";
  }

  const cacheSuffix =
    telemetry.cachedPromptTokens > 0 && telemetry.promptTokens > 0
      ? `/${telemetry.cachedPromptTokens} cached ${formatCacheHitRate(telemetry.cachedPromptTokens, telemetry.promptTokens)}`
      : "";
  const sourceSuffix = telemetry.tokenSource === "estimated" ? " est" : "";
  return `${telemetry.promptTokens} in${cacheSuffix}/${telemetry.responseTokens} out/${telemetry.totalTokens} total${sourceSuffix}`;
}

export function formatSessionTokens(session: SessionTelemetry): string {
  if (session.requests === 0) {
    return "-";
  }

  const cacheSuffix =
    session.cachedPromptTokens > 0 && session.promptTokens > 0
      ? `/${session.cachedPromptTokens} cached ${formatCacheHitRate(session.cachedPromptTokens, session.promptTokens)}`
      : "";
  return `${session.requests} req ${session.promptTokens} in${cacheSuffix}/${session.responseTokens} out`;
}

function formatCacheHitRate(cachedTokens: number, promptTokens: number): string {
  return `${Math.round((cachedTokens / promptTokens) * 100)}%`;
}

export function formatCost(value: number | null): string {
  if (value === null) {
    return "-";
  }

  if (value === 0) {
    return "$0 local";
  }

  if (value > 0 && value < 0.0001) {
    return "<$0.0001 est";
  }

  return `$${value.toFixed(4)} est`;
}

export function formatSpeed(telemetry: ModelTelemetry | null): string {
  if (!telemetry?.evalTokensPerSecond) {
    return "-";
  }

  return `${telemetry.evalTokensPerSecond.toFixed(1)} tok/s`;
}

export function formatLatency(telemetry: ModelTelemetry | null): string {
  if (!telemetry) {
    return "-";
  }

  return formatDuration(telemetry.totalDurationMs);
}

export function formatDuration(durationMs: number): string {
  if (durationMs >= 1000) {
    return `${(durationMs / 1000).toFixed(1)}s`;
  }

  return `${durationMs}ms`;
}

export function formatPercent(value: number | null): string {
  return value === null ? "-" : `${value}%`;
}

export function usageColor(value: number | null): "gray" | "green" | "yellow" | "red" {
  if (value === null) {
    return "gray";
  }

  if (value >= 85) {
    return "red";
  }

  if (value >= 65) {
    return "yellow";
  }

  return "green";
}

export function gpuMemoryColor(stats: GpuStats | null): "gray" | "green" | "yellow" | "red" {
  if (!stats || stats.totalMemoryGb <= 0) {
    return "gray";
  }

  return usageColor(Math.round((stats.usedMemoryGb / stats.totalMemoryGb) * 100));
}

export function temperatureColor(value: number | null): "gray" | "green" | "yellow" | "red" {
  if (value === null) {
    return "gray";
  }

  if (value >= 85) {
    return "red";
  }

  if (value >= 75) {
    return "yellow";
  }

  return "green";
}

export function formatGpuUtilization(stats: GpuStats | null): string {
  return stats ? `${stats.utilizationPercent}%` : "-";
}

export function formatGpuMemory(stats: GpuStats | null): string {
  return stats ? `${stats.usedMemoryGb}/${stats.totalMemoryGb}G` : "-";
}

export function formatGpuTemperature(stats: GpuStats | null): string {
  return stats?.temperatureCelsius !== null && stats?.temperatureCelsius !== undefined ? `${stats.temperatureCelsius}C` : "-";
}

export function formatGpuPower(stats: GpuStats | null): string {
  if (!stats?.powerDrawWatts) {
    return "-";
  }

  return stats.powerLimitWatts ? `${Math.round(stats.powerDrawWatts)}/${Math.round(stats.powerLimitWatts)}W` : `${Math.round(stats.powerDrawWatts)}W`;
}

export function readToggle(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }

  const normalizedValue = value.toLowerCase();
  if (["on", "true", "yes", "1", "enable", "enabled"].includes(normalizedValue)) {
    return true;
  }

  if (["off", "false", "no", "0", "disable", "disabled"].includes(normalizedValue)) {
    return false;
  }

  return fallback;
}

export function normalizeModelAlias(value: string): string {
  if (value === "uncensored" || value === "abliterate" || value === "abliterated") {
    return "huihui_ai/qwen2.5-coder-abliterate:7b";
  }

  if (value === "default" || value === "official") {
    return "qwen2.5-coder:7b";
  }

  return value;
}

export function shortenMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  if (maxLength <= 3) {
    return value.slice(0, maxLength);
  }

  const keep = maxLength - 3;
  const left = Math.ceil(keep / 2);
  const right = Math.floor(keep / 2);
  return `${value.slice(0, left)}...${value.slice(value.length - right)}`;
}

export function toneToColor(tone: LogTone): InkColor {
  switch (tone) {
    case "muted":
      return "gray";
    case "success":
      return "green";
    case "warning":
      return "yellow";
    case "danger":
      return "red";
    case "accent":
      return "cyan";
    case "normal":
      return "white";
  }
}

export function toneToMarker(tone: LogTone): string {
  switch (tone) {
    case "muted":
      return "-";
    case "success":
      return "+";
    case "warning":
      return "!";
    case "danger":
      return "x";
    case "accent":
      return ">";
    case "normal":
      return ":";
  }
}
