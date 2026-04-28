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
    detail: "Advisor subagents add short explorer/planner/reviewer briefs before larger workspace tasks. Turn them off with /agents off when you want less noise or lower latency."
  },
  {
    name: "provider",
    usage: "/provider ollama|gemini|openrouter|nvidia|codex",
    description: "Switch between Ollama, Gemini, OpenRouter, NVIDIA, and Codex inference.",
    category: "model",
    detail: "Provider controls where inference runs. Ollama can be local or remote. Gemini, OpenRouter, NVIDIA, and Codex are cloud providers."
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
    detail: "Codex supports low, medium, high, and xhigh. OpenRouter receives reasoning.effort for compatible models. Gemini maps xhigh to high. Ollama has no common reasoning-effort API, so the value is ignored there. adaptive chooses effort from task complexity."
  },
  {
    name: "onboarding",
    usage: "/onboarding",
    description: "Choose provider, configure API key, and select a model.",
    category: "model"
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
    description: "Switch the Ollama model for this session.",
    category: "model",
    detail: "Use /model to show cached provider models. Use /model <query> to search and select a unique model. OpenRouter supports IDs such as openrouter/auto and :free models."
  },
  {
    name: "models",
    usage: "/models [number|name]",
    description: "List installed Ollama models or select one.",
    category: "model",
    detail: "Loads models from the active provider and shows them in the palette. Use /models free, /models llama, or /models 3 to search or select."
  },
  {
    name: "mode",
    usage: "/mode plan|build",
    description: "Switch between read-only planning and implementation mode.",
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
    description: "Show active model, host, permissions, and token telemetry.",
    category: "session"
  },
  {
    name: "doctor",
    usage: "/doctor",
    description: "Check Node, Git, and the selected Ollama host.",
    category: "utility"
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

  const commandPart = input.slice(1).trimStart().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!commandPart) {
    return slashCommands;
  }

  const prefixMatches = slashCommands.filter((command) => command.name.startsWith(commandPart));
  if (prefixMatches.length > 0) {
    return prefixMatches;
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
    command.shortcut ?? ""
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
