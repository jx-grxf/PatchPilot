import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const defaultPatchPilotInstructions = `# PATCHPILOT.md

## Workspace Instructions
- Keep changes focused and easy to review.
- Read the relevant files before editing.
- Prefer tests or typechecks after code changes.
- Do not commit secrets, generated caches, or local session files.
`;

export async function ensurePatchPilotInstructions(workspace: string): Promise<{ created: boolean; path: string }> {
  const filePath = path.join(path.resolve(workspace), "PATCHPILOT.md");
  const existing = await readFile(filePath, "utf8").catch(() => "");
  if (!existing.trim()) {
    await writeFile(filePath, defaultPatchPilotInstructions, "utf8");
    await ensureGitignoreEntry(workspace, ".patchpilot/");
    return {
      created: true,
      path: filePath
    };
  }

  await ensureGitignoreEntry(workspace, ".patchpilot/");
  return {
    created: false,
    path: filePath
  };
}

async function ensureGitignoreEntry(workspace: string, entry: string): Promise<void> {
  const gitignorePath = path.join(path.resolve(workspace), ".gitignore");
  const content = await readFile(gitignorePath, "utf8").catch(() => "");
  const lines = content.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes(entry)) {
    return;
  }

  await appendFile(gitignorePath, `${content.endsWith("\n") || !content ? "" : "\n"}${entry}\n`, "utf8");
}
