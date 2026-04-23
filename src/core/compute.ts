import { normalizeOllamaBaseUrl } from "./ollama.js";

export type ComputeTargetKind = "local" | "remote";

export type ComputeTarget = {
  kind: ComputeTargetKind;
  url: string;
  host: string;
  label: string;
};

const localHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function describeComputeTarget(value: string): ComputeTarget {
  const url = normalizeOllamaBaseUrl(value);
  const parsedUrl = new URL(url);
  const host = parsedUrl.host;
  const kind: ComputeTargetKind = localHosts.has(parsedUrl.hostname.toLowerCase()) ? "local" : "remote";

  return {
    kind,
    url,
    host,
    label: kind === "local" ? "local Ollama" : `remote Ollama at ${host}`
  };
}

export function isLocalComputeTarget(value: string): boolean {
  return describeComputeTarget(value).kind === "local";
}
