export type SlashCommand = {
  name: string;
  usage: string;
  description: string;
};

export const slashCommands: SlashCommand[] = [
  {
    name: "help",
    usage: "/help",
    description: "Show available PatchPilot commands."
  },
  {
    name: "permissions",
    usage: "/permissions",
    description: "Show write and shell permissions."
  },
  {
    name: "agents",
    usage: "/agents on|off",
    description: "Enable or disable planner/reviewer subagents."
  },
  {
    name: "write",
    usage: "/write on|off",
    description: "Enable or disable workspace writes."
  },
  {
    name: "shell",
    usage: "/shell on|off",
    description: "Enable or disable shell commands."
  },
  {
    name: "model",
    usage: "/model <name|uncensored|default>",
    description: "Switch the Ollama model for this session."
  },
  {
    name: "mode",
    usage: "/mode plan|build",
    description: "Switch between read-only planning and implementation mode."
  },
  {
    name: "plan",
    usage: "/plan",
    description: "Shortcut for /mode plan."
  },
  {
    name: "build",
    usage: "/build",
    description: "Shortcut for /mode build."
  },
  {
    name: "connect",
    usage: "/connect <host|local>",
    description: "Connect to a remote Ollama host."
  },
  {
    name: "hosts",
    usage: "/hosts",
    description: "List remembered and suggested Ollama hosts."
  },
  {
    name: "doctor",
    usage: "/doctor",
    description: "Check Node, Git, and the selected Ollama host."
  },
  {
    name: "clear",
    usage: "/clear",
    description: "Clear the current transcript."
  },
  {
    name: "exit",
    usage: "/exit",
    description: "Quit PatchPilot."
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
  return slashCommands.map((command) => `${command.usage} - ${command.description}`).join("\n");
}
