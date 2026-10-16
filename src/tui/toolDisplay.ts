import type { AgentEventToolName } from "../core/types.js";

/**
 * How a tool call reads in the transcript: a short verb and its target, as in
 * `Write(index.html)`. The internal names (`write_file`, `run_shell`) are an
 * implementation detail the user never typed.
 */
const toolVerbs: Record<AgentEventToolName, string> = {
  update_todo: "Plan",
  list_files: "List",
  find_files: "Glob",
  read_file: "Read",
  read_range: "Read",
  file_info: "Stat",
  search_text: "Search",
  fetch_url: "Fetch",
  inspect_document: "Read",
  memory_remember: "Remember",
  memory_search: "Recall",
  git_status: "Git",
  git_diff: "Diff",
  git_log: "Git",
  git_show: "Git",
  list_changed_files: "Git",
  list_scripts: "Scripts",
  repo_overview: "Overview",
  test_list: "Tests",
  dependency_tree: "Dependencies",
  write_file: "Write",
  edit_file: "Update",
  create_pdf: "Write",
  create_docx: "Write",
  apply_patch: "Update",
  run_script: "Run",
  run_tests: "Test",
  run_shell: "Bash",
  subagent: "Task"
};

export function formatToolHeading(name: AgentEventToolName | undefined, label: string, target: string | undefined): string {
  const verb = name ? toolVerbs[name] : label;
  return target ? `${verb}(${target})` : verb;
}

/**
 * What the run line says while a call streams. Keys are the nine-tool surface
 * names, plus the internal names a legacy-envelope model may still emit.
 */
const writingLabels: Record<string, string> = {
  write: "Writing a file",
  write_file: "Writing a file",
  edit: "Writing an edit",
  edit_file: "Writing an edit",
  apply_patch: "Writing an edit",
  bash: "Preparing a command",
  run_shell: "Preparing a command",
  task: "Delegating",
  todo: "Updating the plan",
  read: "Choosing a file",
  glob: "Choosing files",
  grep: "Preparing a search",
  fetch_url: "Preparing a fetch"
};

export function describeStreamingCall(tool: string): string {
  return writingLabels[tool] ?? `Calling ${tool}`;
}

/** The one argument that identifies a call: the file, command, pattern or URL. */
export function describeToolTarget(args: Record<string, unknown> | undefined, maxLength = 80): string | undefined {
  if (!args) {
    return undefined;
  }
  for (const key of ["path", "command", "script", "pattern", "query", "url", "ref", "description"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      const normalized = value.replace(/\s+/g, " ").trim();
      return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
    }
  }
  return undefined;
}
