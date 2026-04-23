export type SlashCommand = {
  name: string;
  usage: string;
  description: string;
  category: "session" | "permissions" | "model" | "compute" | "utility";
  shortcut?: string;
};

export const slashCommands: SlashCommand[] = [
  {
    name: "help",
    usage: "/help",
    description: "Show available PatchPilot commands.",
    category: "utility"
  },
  {
    name: "permissions",
    usage: "/permissions",
    description: "Show write and shell permissions.",
    category: "permissions"
  },
  {
    name: "agents",
    usage: "/agents on|off",
    description: "Enable or disable planner/reviewer subagents.",
    category: "session"
  },
  {
    name: "provider",
    usage: "/provider ollama|gemini",
    description: "Switch between local Ollama and Gemini API inference.",
    category: "model"
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
    category: "permissions"
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
    category: "model"
  },
  {
    name: "models",
    usage: "/models [number|name]",
    description: "List installed Ollama models or select one.",
    category: "model"
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
    category: "compute"
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
    category: "utility"
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

  return slashCommands.filter((command) => command.name.startsWith(commandPart));
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
