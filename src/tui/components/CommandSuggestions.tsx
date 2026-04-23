import React from "react";
import { Box, Text } from "ink";
import { filterSlashCommands } from "../commands.js";
import type { OllamaHost } from "../hosts.js";

export function CommandSuggestions(props: {
  input: string;
  hostOptions: OllamaHost[];
  modelOptions: string[];
  currentModel: string;
}): React.ReactElement | null {
  const suggestions = filterSlashCommands(props.input);
  if (suggestions.length === 0) {
    return null;
  }

  const commandInput = props.input.trimStart();
  const hosts = commandInput.startsWith("/connect") ? props.hostOptions.slice(0, 5) : [];
  const models = commandInput.startsWith("/models") ? props.modelOptions.slice(0, 8) : [];

  return (
    <Box borderStyle="round" borderColor="gray" flexDirection="column" paddingX={1} marginTop={1}>
      <Text color="gray">Command palette</Text>
      {suggestions.slice(0, 8).map((command) => (
        <Box key={command.name}>
          <Box width={16}>
            <Text color="gray">{command.category}</Text>
          </Box>
          <Box width={30}>
            <Text color="cyan">{command.usage}</Text>
          </Box>
          <Text color="gray">
            {command.description}
            {command.shortcut ? ` (${command.shortcut})` : ""}
          </Text>
        </Box>
      ))}
      {hosts.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">Last scanned Ollama hosts</Text>
          {hosts.map((host, index) => (
            <Text key={host.url} color="gray">
              {index + 1}. {host.label} {host.url}
            </Text>
          ))}
        </Box>
      ) : null}
      {models.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">Last loaded Ollama models</Text>
          {models.map((model, index) => (
            <Text key={model} color={model === props.currentModel ? "green" : "gray"}>
              {index + 1}. {model}
              {model === props.currentModel ? "  current" : ""}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
