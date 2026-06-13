export type SlashCommand = {
  name: string;
  usage: string;
  description: string;
  category: "session" | "permissions" | "model" | "compute" | "utility";
  shortcut?: string;
  aliases?: string[];
  detail?: string;
};

export const slashCommands: SlashCommand[] = [
  {
    name: "help",
    usage: "/help",
    description: "Show available PatchPilot commands.",
    category: "utility",
    detail: "Use /help to list commands. Use /help <command> for focused help, for example /help think or /help model."
  },
  {
    name: "permissions",
    usage: "/permissions",
    description: "Show write and shell permissions.",
    category: "permissions",
    aliases: ["perms"]
  },
  {
    name: "agents",
    usage: "/agents on|off",
    description: "Enable or disable explorer/planner/reviewer subagents.",
    category: "session",
    aliases: ["subagents"],
    detail: "Advisor subagents add short explorer/planner/reviewer briefs before larger workspace tasks. They are off by default; turn them on with /agents on when you want extra review context."
  },
  {
    name: "provider",
    usage: "/provider ollama|gemini|gemini-wrapper|openrouter|nvidia|codex",
    description: "Switch between Ollama, Gemini, Gemini-Wrapper, OpenRouter, NVIDIA, and Codex inference.",
    category: "model",
    detail: "Provider controls where inference runs. Gemini-Wrapper runs the installed gemini_webapi bridge with pasted cookies or an explicit local browser-cookie import."
  },
  {
    name: "think",
    usage: "/think fixed|adaptive",
    description: "Switch between fixed and adaptive thinking budgets.",
    category: "session",
    aliases: ["thinking"],
    detail: "fixed uses exactly the configured --steps budget. adaptive shortens simple tasks and expands complex tasks up to a bounded budget. It does not change provider reasoning level; use /reasoning for that."
  },
  {
    name: "reasoning",
    usage: "/reasoning low|medium|high|xhigh|adaptive",
    description: "Set provider reasoning effort where the provider supports it.",
    category: "model",
    detail: "Codex supports low, medium, high, and xhigh. OpenRouter receives reasoning.effort for compatible models. Gemini maps xhigh to high. Gemini-Wrapper does not expose Gemini Web Denkaufwand controls yet. Ollama has no common reasoning-effort API, so the value is ignored there. adaptive chooses effort from task complexity."
  },
  {
    name: "onboarding",
    usage: "/onboarding",
    description: "Choose provider, configure API key, and select a model.",
    category: "model"
  },
  {
    name: "new",
    usage: "/new",
    description: "Start a fresh PatchPilot session and clear the current context.",
    category: "session",
    detail: "Clears the visible transcript, telemetry, advisor notes, approvals, and starts a new session file. Provider, model, mode, and permissions stay unchanged."
  },
  {
    name: "recap",
    usage: "/recap",
    description: "Summarize the current session's tasks, outcomes, tools, failures, and approvals.",
    category: "session",
    aliases: ["summary"],
    detail: "Builds an instant recap from the persisted session log. It does not spend model tokens and also works while a run is active."
  },
  {
    name: "context",
    usage: "/context show|files|pins|clear|export",
    description: "Inspect and manage saved session context.",
    category: "session",
    aliases: ["ctx"],
    detail: "Use /context show for the dashboard, /context files for path-backed context, /context pins for pinned items, /context clear to drop unpinned context, or /context export to print the snapshot path and JSON."
  },
  {
    name: "context show",
    usage: "/context show",
    description: "Show saved session context counts, pins, tokens, and recent items.",
    category: "session",
    aliases: ["ctx show"],
    detail: "Reads the current session ContextStore snapshot and prints the dashboard used for context-aware follow-up runs."
  },
  {
    name: "context files",
    usage: "/context files",
    description: "List active context entries that point at files, artifacts, or attachments.",
    category: "session",
    aliases: ["ctx files"],
    detail: "Shows active path-backed context so you can see which files or artifacts are still part of the current session memory."
  },
  {
    name: "context pins",
    usage: "/context pins",
    description: "List pinned context items that compaction must keep.",
    category: "session",
    aliases: ["ctx pins", "context pinned"],
    detail: "Pinned context is preserved by /context clear and /compact now. Use this to audit what will remain sticky."
  },
  {
    name: "context clear",
    usage: "/context clear",
    description: "Drop unpinned saved context for the current session.",
    category: "session",
    aliases: ["ctx clear"],
    detail: "Clears unpinned ContextStore items for this session. Pinned files and other pinned items stay active."
  },
  {
    name: "context export",
    usage: "/context export",
    description: "Print the current context snapshot path and JSON.",
    category: "session",
    aliases: ["ctx export"],
    detail: "Writes or refreshes the current .patchpilot/context snapshot, then prints the path and snapshot JSON for inspection."
  },
  {
    name: "write",
    usage: "/write on|off",
    description: "Enable or disable workspace writes.",
    category: "permissions",
    aliases: ["apply"]
  },
  {
    name: "shell",
    usage: "/shell on|off",
    description: "Enable or disable shell commands.",
    category: "permissions"
  },
  {
    name: "model",
    usage: "/model <name|uncensored|default>",
    description: "Switch the active provider model for this session.",
    category: "model",
    detail: "Use /model to show cached provider models. Use /model <query> to search and select a unique model. OpenRouter supports IDs such as openrouter/auto and :free models."
  },
  {
    name: "models",
    usage: "/models [number|name]",
    description: "List active provider models or select one.",
    category: "model",
    detail: "Loads models from the active provider and shows them in the palette. Use /models free, /models llama, or /models 3 to search or select."
  },
  {
    name: "mode",
    usage: "/mode plan|build|bypass",
    description: "Switch between read-only, approval, and bypass modes.",
    category: "session",
    shortcut: "tab"
  },
  {
    name: "plan",
    usage: "/plan",
    description: "Shortcut for /mode plan.",
    category: "session"
  },
  {
    name: "build",
    usage: "/build",
    description: "Shortcut for /mode build.",
    category: "session"
  },
  {
    name: "bypass",
    usage: "/bypass",
    description: "Request build mode without per-tool approvals.",
    category: "permissions"
  },
  {
    name: "connect",
    usage: "/connect <host|local>",
    description: "Connect to a remote Ollama host.",
    category: "compute",
    aliases: ["host", "ollama"]
  },
  {
    name: "eject",
    usage: "/eject [model|all]",
    description: "Unload Ollama models from the active host.",
    category: "compute",
    detail: "/eject unloads the current Ollama model with keep_alive: 0. /eject all unloads models PatchPilot used in this session plus running models reported by /api/ps. Cloud providers do not need eject."
  },
  {
    name: "hosts",
    usage: "/hosts",
    description: "List remembered and suggested Ollama hosts.",
    category: "compute"
  },
  {
    name: "status",
    usage: "/status",
    description: "Operational dock: provider/model, permissions, compute target, session, advisors, tool counters.",
    category: "session"
  },
  {
    name: "usage",
    usage: "/usage",
    description: "Show detailed token, tool-call, cache, and cost counters.",
    category: "session",
    detail: "Shows current-session request counts, input/output/cache tokens, tool counters by name, and estimated cost/savings. If exact model pricing is unavailable, PatchPilot marks the figure as fallback-priced."
  },
  {
    name: "compact",
    usage: "/compact now|auto|reset",
    description: "Run or configure session-context compaction.",
    category: "session",
    aliases: ["compress"],
    detail: "Use /compact now to compact eligible unpinned context, /compact auto [on|off] to toggle automatic compaction, or /compact reset to drop generated summaries and turn auto-compaction off."
  },
  {
    name: "compact now",
    usage: "/compact now",
    description: "Compact eligible unpinned context immediately.",
    category: "session",
    aliases: ["compress now"],
    detail: "Pinned context and exact referenced file/artifact paths are kept. Secret-like context is dropped rather than summarized."
  },
  {
    name: "compact auto",
    usage: "/compact auto [on|off]",
    description: "Toggle automatic ContextStore compaction.",
    category: "session",
    aliases: ["compress auto"],
    detail: "Without on/off, /compact auto enables automatic compaction. Use /compact auto off to disable it."
  },
  {
    name: "compact reset",
    usage: "/compact reset",
    description: "Drop generated context summaries and disable automatic compaction.",
    category: "session",
    aliases: ["compress reset"],
    detail: "Leaves regular and pinned context items in place, but marks generated summary items as dropped and turns automatic compaction off."
  },
  {
    name: "sessions",
    usage: "/sessions",
    description: "List recent PatchPilot sessions for this workspace.",
    category: "session"
  },
  {
    name: "resume",
    usage: "/resume [session-id]",
    description: "Load a previous session summary.",
    category: "session"
  },
  {
    name: "diff",
    usage: "/diff",
    description: "Show the current Git diff.",
    category: "session"
  },
  {
    name: "approve",
    usage: "/approve once|session",
    description: "Approve the pending risky tool request.",
    category: "permissions"
  },
  {
    name: "deny",
    usage: "/deny",
    description: "Deny the pending risky tool request.",
    category: "permissions"
  },
  {
    name: "doctor",
    usage: "/doctor [fix]",
    description: "Check Node, Git, and active provider diagnostics.",
    category: "utility",
    detail: "/doctor checks requirements without changing the machine. /doctor fix applies safe repairs such as installing the managed Gemini-API bridge."
  },
  {
    name: "cleanup",
    usage: "/cleanup cache|sessions|temp|all",
    description: "Clean PatchPilot cache, saved sessions, temp files, or all workspace state.",
    category: "utility",
    detail: "Use cache/temp for safe cleanup. sessions/all delete saved workspace transcripts and start a fresh session."
  },
  {
    name: "experimental",
    usage: "/experimental [file-analysis|memory|subagents|shell-metacharacters] [on|off]",
    description: "Open or update experimental feature toggles.",
    category: "utility",
    detail: "Run /experimental to open the checkbox menu. Use space to toggle file-analysis, memory, subagents, and shell-metacharacters."
  },
  {
    name: "theme",
    usage: "/theme [new|legacy]",
    description: "Switch between the New experimental shell and the Legacy TUI.",
    category: "utility",
    detail: "Run /theme to open the picker, or /theme new / /theme legacy directly. New is the default fullscreen shell; Legacy is the original sidebar TUI. The choice is remembered."
  },
  {
    name: "init",
    usage: "/init",
    description: "Create PATCHPILOT.md workspace instructions.",
    category: "utility",
    detail: "Creates a PATCHPILOT.md file similar to AGENTS.md or CLAUDE.md and ensures .patchpilot/ stays ignored."
  },
  {
    name: "clear",
    usage: "/clear",
    description: "Clear the current transcript.",
    category: "utility"
  },
  {
    name: "exit",
    usage: "/exit",
    description: "Quit PatchPilot.",
    category: "utility",
    aliases: ["quit", "q"]
  }
];

export function filterSlashCommands(input: string): SlashCommand[] {
  if (!input.startsWith("/")) {
    return [];
  }

  const normalizedInput = input.slice(1).trimStart().replace(/\s+/g, " ").toLowerCase();
  const commandPart = normalizedInput.split(/\s+/)[0] ?? "";
  if (!commandPart) {
    return slashCommands;
  }

  const fullPrefixMatches = slashCommands.filter((command) => command.name.startsWith(normalizedInput));
  const fullAliasPrefixMatches = slashCommands.filter((command) => command.aliases?.some((alias) => alias.startsWith(normalizedInput)));
  if (fullPrefixMatches.length > 0) {
    return [...fullPrefixMatches, ...fullAliasPrefixMatches.filter((command) => !fullPrefixMatches.includes(command))];
  }

  if (fullAliasPrefixMatches.length > 0) {
    return fullAliasPrefixMatches;
  }

  const prefixMatches = slashCommands.filter((command) => command.name.startsWith(commandPart));
  const aliasPrefixMatches = slashCommands.filter((command) => command.aliases?.some((alias) => alias.startsWith(commandPart)));
  if (prefixMatches.length > 0) {
    return [...prefixMatches, ...aliasPrefixMatches.filter((command) => !prefixMatches.includes(command))];
  }

  if (aliasPrefixMatches.length > 0) {
    return aliasPrefixMatches;
  }

  return slashCommands
    .map((command) => ({
      command,
      score: scoreSlashCommand(command, commandPart)
    }))
    .filter((item): item is { command: SlashCommand; score: number } => item.score !== null)
    .sort((left, right) => left.score - right.score || left.command.name.localeCompare(right.command.name))
    .map((item) => item.command);
}

export function formatCommandList(): string {
  return slashCommands.map((command) => command.usage).join("  ");
}

export function formatCommandDetail(): string {
  return slashCommands
    .map((command) => {
      const shortcut = command.shortcut ? ` [${command.shortcut}]` : "";
      return `${command.category.padEnd(11)} ${command.usage}${shortcut} - ${command.description}`;
    })
    .join("\n");
}

export function formatCommandHelp(name: string): string | null {
  const normalizedName = name.trim().replace(/^\//, "").toLowerCase();
  const command = slashCommands.find((item) => item.name === normalizedName || item.aliases?.includes(normalizedName));
  if (!command) {
    return null;
  }

  const aliases = command.aliases?.length ? `\naliases: ${command.aliases.map((alias) => `/${alias}`).join(", ")}` : "";
  return [`${command.usage} - ${command.description}`, command.detail ?? "", aliases].filter(Boolean).join("\n");
}

function scoreSlashCommand(command: SlashCommand, query: string): number | null {
  const haystacks = [
    command.name,
    command.usage,
    command.description,
    command.category,
    command.shortcut ?? "",
    ...(command.aliases ?? [])
  ].map((value) => value.toLowerCase());

  if (command.name.startsWith(query)) {
    return 0;
  }

  if (command.usage.toLowerCase().startsWith(`/${query}`)) {
    return 1;
  }

  const directMatchIndex = haystacks.findIndex((value) => value.includes(query));
  if (directMatchIndex >= 0) {
    return 2 + directMatchIndex;
  }

  const queryTokens = query.split(/[\s-]+/).filter(Boolean);
  if (queryTokens.length === 0) {
    return null;
  }

  const tokenMatch = haystacks.some((value) => queryTokens.every((token) => value.includes(token)));
  return tokenMatch ? 10 : null;
}
