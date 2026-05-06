import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export function loadDotEnv(cwd = process.cwd()): void {
  const envPath = path.join(cwd, ".env");
  if (!existsSync(envPath)) {
    return;
  }

  const content = readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const entry = parseEnvLine(line);
    if (!entry || process.env[entry.key] !== undefined) {
      continue;
    }

    process.env[entry.key] = entry.value;
  }
}

export function saveDotEnvValues(values: Record<string, string>, cwd = process.cwd()): void {
  const envPath = path.join(cwd, ".env");
  const existingContent = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const lines = existingContent ? existingContent.split(/\r?\n/) : [];
  const remainingValues = new Map(Object.entries(values));
  const nextLines = lines.map((line) => {
    const parsedLine = parseEnvLine(line);
    if (!parsedLine || !remainingValues.has(parsedLine.key)) {
      return line;
    }

    const value = remainingValues.get(parsedLine.key) ?? "";
    remainingValues.delete(parsedLine.key);
    return `${parsedLine.key}=${quoteEnvValue(value)}`;
  });

  while (nextLines.at(-1) === "") {
    nextLines.pop();
  }

  for (const [key, value] of remainingValues) {
    nextLines.push(`${key}=${quoteEnvValue(value)}`);
  }

  writeFileSync(envPath, `${nextLines.join("\n").replace(/\n+$/, "")}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  tryChmod(envPath, 0o600);
}

export function getPatchPilotConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PATCHPILOT_CONFIG_DIR?.trim() || path.join(homedir(), ".patchpilot");
}

export function getPatchPilotEnvPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getPatchPilotConfigDir(env), ".env");
}

export function loadPatchPilotEnv(env: NodeJS.ProcessEnv = process.env): void {
  const envPath = getPatchPilotEnvPath(env);
  if (!existsSync(envPath)) {
    return;
  }

  loadDotEnv(path.dirname(envPath));
}

export function savePatchPilotEnvValues(values: Record<string, string>, env: NodeJS.ProcessEnv = process.env): void {
  const configDir = getPatchPilotConfigDir(env);
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  tryChmod(configDir, 0o700);
  saveDotEnvValues(values, configDir);
}

function tryChmod(filePath: string, mode: number): void {
  try {
    chmodSync(filePath, mode);
  } catch {
    // Best-effort hardening; chmod can be limited on some Windows filesystems.
  }
}

function parseEnvLine(line: string): { key: string; value: string } | null {
  const trimmedLine = line.trim();
  if (!trimmedLine || trimmedLine.startsWith("#")) {
    return null;
  }

  const separatorIndex = trimmedLine.indexOf("=");
  if (separatorIndex <= 0) {
    return null;
  }

  const key = trimmedLine.slice(0, separatorIndex).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return null;
  }

  return {
    key,
    value: unquoteEnvValue(trimmedLine.slice(separatorIndex + 1).trim())
  };
}

function unquoteEnvValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  const commentIndex = value.indexOf(" #");
  return commentIndex >= 0 ? value.slice(0, commentIndex).trimEnd() : value;
}

function quoteEnvValue(value: string): string {
  if (!value || /[\s#"']/.test(value)) {
    return JSON.stringify(value);
  }

  return value;
}
