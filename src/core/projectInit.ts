import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const patchPilotInitPrompt = `Initialize this repository for PatchPilot.

Inspect the project structure, README/package/config files, test/build scripts, and any existing agent instruction files.
Then create or update PATCHPILOT.md with concise, project-specific guidance for future coding agents.

Requirements:
- Write real guidance for this repository, not generic boilerplate.
- Include the common development commands that actually exist.
- Include project-specific architecture notes, safety boundaries, test/build expectations, and files/folders to avoid.
- Keep it readable for an agent: headings, short bullets, no marketing copy.
- If PATCHPILOT.md already exists, preserve useful existing guidance and improve it instead of replacing blindly.
- Use workspace-relative paths only.`;

export async function ensurePatchPilotInstructions(workspace: string): Promise<{ created: boolean; path: string }> {
  const filePath = path.join(path.resolve(workspace), "PATCHPILOT.md");
  const existing = await readFile(filePath, "utf8").catch(() => "");
  if (!existing.trim()) {
    await writeFile(filePath, "# PATCHPILOT.md\n\nRun `/init` in the PatchPilot TUI to generate project-specific instructions with the selected model.\n", "utf8");
    await ensurePatchPilotGitignore(workspace);
    return {
      created: true,
      path: filePath
    };
  }

  await ensurePatchPilotGitignore(workspace);
  return {
    created: false,
    path: filePath
  };
}

export async function ensurePatchPilotGitignore(workspace: string): Promise<void> {
  await ensureGitignoreEntry(workspace, ".patchpilot/");
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
