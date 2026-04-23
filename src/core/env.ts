import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

  writeFileSync(envPath, `${nextLines.join("\n").replace(/\n+$/, "")}\n`, "utf8");
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
