import { execFile as execFileCallback, spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { PatchPilotDiscordConfig } from "./config.js";

const execFile = promisify(execFileCallback);

export const patchPilotDiscordLaunchdLabel = "dev.jx-grxf.patchpilot-discord";

export type LaunchdStatus = {
  loaded: boolean;
  running: boolean;
  pid?: number;
  plistPath: string;
  raw: string;
};

export function patchPilotDiscordPlistPath(): string {
  return path.join(homedir(), "Library", "LaunchAgents", `${patchPilotDiscordLaunchdLabel}.plist`);
}

export async function installDiscordLaunchAgent(config: PatchPilotDiscordConfig): Promise<string> {
  const plistPath = patchPilotDiscordPlistPath();
  await mkdir(path.dirname(plistPath), { recursive: true });
  await mkdir(config.logsDir, { recursive: true });
  await writeFile(plistPath, createLaunchAgentPlist(config), "utf8");
  const lint = await execCommand("plutil", ["-lint", plistPath]);
  if (!lint.ok) {
    throw new Error(`Invalid LaunchAgent plist:\n${lint.stderr || lint.stdout}`);
  }
  await runLaunchctl(["bootout", serviceTarget()], { allowFailure: true });
  await runLaunchctl(["enable", serviceTarget()]);
  await runLaunchctl(["bootstrap", domainTarget(), plistPath]);
  await runLaunchctl(["kickstart", "-k", serviceTarget()]);
  return plistPath;
}

export async function stopDiscordLaunchAgent(): Promise<void> {
  await runLaunchctl(["bootout", serviceTarget()], { allowFailure: true });
}

export async function uninstallDiscordLaunchAgent(): Promise<void> {
  await stopDiscordLaunchAgent();
  await rm(patchPilotDiscordPlistPath(), { force: true });
}

export async function readDiscordLaunchdStatus(): Promise<LaunchdStatus> {
  const plistPath = patchPilotDiscordPlistPath();
  const result = await execCommand("launchctl", ["print", serviceTarget()]);
  if (!result.ok) {
    return {
      loaded: false,
      running: false,
      plistPath,
      raw: result.stderr || result.stdout
    };
  }
  const pidMatch = result.stdout.match(/\bpid\s*=\s*(\d+)/i);
  return {
    loaded: true,
    running: Boolean(pidMatch),
    pid: pidMatch ? Number.parseInt(pidMatch[1] ?? "", 10) : undefined,
    plistPath,
    raw: result.stdout
  };
}

export async function followDiscordLogs(config: PatchPilotDiscordConfig): Promise<void> {
  await mkdir(config.logsDir, { recursive: true });
  const child = spawn("tail", ["-f", path.join(config.logsDir, "bot.out.log"), path.join(config.logsDir, "bot.err.log")], {
    stdio: "inherit"
  });
  await new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code && code !== 0) {
        reject(new Error(`tail exited with code ${code}`));
        return;
      }
      resolve();
    });
  });
}

export function summarizeLaunchdStatus(status: LaunchdStatus): string {
  if (!status.loaded) {
    return `not loaded (${status.plistPath})`;
  }
  return status.running ? `running pid ${status.pid ?? "unknown"} (${status.plistPath})` : `loaded but not running (${status.plistPath})`;
}

function createLaunchAgentPlist(config: PatchPilotDiscordConfig): string {
  const cliPath = fileURLToPath(new URL("../cli.js", import.meta.url));
  const nodePath = process.execPath;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${patchPilotDiscordLaunchdLabel}</string>
  <key>WorkingDirectory</key>
  <string>${escapePlist(config.defaultWorkspace.path)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapePlist(nodePath)}</string>
    <string>${escapePlist(cliPath)}</string>
    <string>discord</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapePlist(path.dirname(nodePath))}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>PATCHPILOT_CONFIG_DIR</key>
    <string>${escapePlist(config.configDir)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapePlist(path.join(config.logsDir, "bot.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapePlist(path.join(config.logsDir, "bot.err.log"))}</string>
</dict>
</plist>
`;
}

function domainTarget(): string {
  return `gui/${process.getuid?.() ?? ""}`;
}

function serviceTarget(): string {
  return `${domainTarget()}/${patchPilotDiscordLaunchdLabel}`;
}

async function runLaunchctl(args: string[], options: { allowFailure?: boolean } = {}): Promise<void> {
  const result = await execCommand("launchctl", args);
  if (result.ok || options.allowFailure) {
    return;
  }
  throw new Error(`launchctl ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
}

async function execCommand(command: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFile(command, args);
    return { ok: true, stdout, stderr };
  } catch (error) {
    const commandError = error as { stdout?: string; stderr?: string };
    return {
      ok: false,
      stdout: commandError.stdout ?? "",
      stderr: commandError.stderr ?? ""
    };
  }
}

function escapePlist(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
