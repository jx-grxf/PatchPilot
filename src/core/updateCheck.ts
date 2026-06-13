import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type UpdateCheckResult =
  | {
      available: false;
      currentVersion: string;
      latestVersion: string | null;
      source: "npm" | "github" | "none";
    }
  | {
      available: true;
      currentVersion: string;
      latestVersion: string;
      source: "npm" | "github";
      command: string;
    };

export type UpdateInstallResult = {
  version: string;
  command: string;
};

const packageName = "@jx-grxf/patchpilot";
const githubLatestReleaseUrl = "https://api.github.com/repos/jx-grxf/PatchPilot/releases/latest";

export async function checkForPatchPilotUpdate(currentVersion: string, signal?: AbortSignal): Promise<UpdateCheckResult> {
  const npmVersion = await fetchLatestNpmVersion(signal).catch(() => null);
  if (npmVersion) {
    return toUpdateResult(currentVersion, npmVersion, "npm");
  }

  const githubVersion = await fetchLatestGithubReleaseVersion(signal).catch(() => null);
  if (githubVersion) {
    return toUpdateResult(currentVersion, githubVersion, "github");
  }

  return {
    available: false,
    currentVersion,
    latestVersion: null,
    source: "none"
  };
}

export async function installPatchPilotUpdate(version: string): Promise<UpdateInstallResult> {
  const command = updateCommand(version);
  await execFileAsync("npm", ["install", "-g", `${packageName}@${version}`], {
    timeout: 180_000,
    maxBuffer: 2_000_000,
    windowsHide: true
  });
  return {
    version,
    command
  };
}

export function updateCommand(version = "latest"): string {
  return `npm install -g ${packageName}@${version}`;
}

function toUpdateResult(currentVersion: string, latestVersion: string, source: "npm" | "github"): UpdateCheckResult {
  if (compareSemver(latestVersion, currentVersion) <= 0) {
    return {
      available: false,
      currentVersion,
      latestVersion,
      source
    };
  }

  return {
    available: true,
    currentVersion,
    latestVersion,
    source,
    command: updateCommand(latestVersion)
  };
}

async function fetchLatestNpmVersion(signal?: AbortSignal): Promise<string | null> {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`, {
    headers: {
      Accept: "application/json"
    },
    signal
  });
  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as { version?: unknown };
  return typeof payload.version === "string" ? payload.version : null;
}

async function fetchLatestGithubReleaseVersion(signal?: AbortSignal): Promise<string | null> {
  const response = await fetch(githubLatestReleaseUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "PatchPilot"
    },
    signal
  });
  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as { tag_name?: unknown; name?: unknown };
  return normalizeVersion(typeof payload.tag_name === "string" ? payload.tag_name : typeof payload.name === "string" ? payload.name : "");
}

function compareSemver(left: string, right: string): number {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    const diff = leftParts[index] - rightParts[index];
    if (diff !== 0) {
      return diff;
    }
  }

  return 0;
}

function parseVersion(value: string): [number, number, number] {
  const [major = "0", minor = "0", patch = "0"] = normalizeVersion(value).split(".");
  return [readVersionPart(major), readVersionPart(minor), readVersionPart(patch)];
}

function normalizeVersion(value: string): string {
  return value.trim().replace(/^v/i, "");
}

function readVersionPart(value: string): number {
  const parsed = Number.parseInt(value.replace(/[^0-9].*$/, ""), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}
