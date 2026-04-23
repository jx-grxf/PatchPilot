import React from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import type { ModelProvider } from "../../core/types.js";

export type OnboardingState =
  | {
      step: "provider";
    }
  | {
      step: "gemini-key";
    }
  | {
      step: "codex-login";
    }
  | {
      step: "model";
      provider: ModelProvider;
      models: string[];
    };

const providerOptions: Array<{ value: ModelProvider; label: string; description: string }> = [
  {
    value: "ollama",
    label: "Ollama",
    description: "Local or LAN model server"
  },
  {
    value: "gemini",
    label: "Gemini",
    description: "Google API key from PatchPilot config"
  },
  {
    value: "codex",
    label: "Codex",
    description: "ChatGPT login through Codex CLI"
  }
];

export function OnboardingPanel(props: {
  state: OnboardingState;
  height: number;
  selectedIndex: number;
  input: string;
  busyMessage?: string | null;
  onInputChange: (value: string) => void;
  onInputSubmit: (value: string) => void;
}): React.ReactElement {
  const currentStepIndex = props.state.step === "provider" ? 0 : props.state.step === "gemini-key" || props.state.step === "codex-login" ? 1 : 2;
  const modelState = props.state.step === "model" ? props.state : null;

  return (
    <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={2} height={Math.max(18, props.height + 4)}>
      <Text color="cyan" bold>
        PatchPilot Setup
      </Text>
      <Text color="gray">A dedicated first-run flow for provider, auth, and model setup.</Text>
      <Box marginTop={1}>
        {["provider", "auth", "model"].map((step, index) => (
          <Text key={step} color={index <= currentStepIndex ? "cyan" : "gray"}>
            {index > 0 ? "  " : ""}
            [{index + 1}] {step}
          </Text>
        ))}
      </Box>
      {props.busyMessage ? (
        <Box marginTop={1}>
          <Text color="yellow">{props.busyMessage}</Text>
        </Box>
      ) : null}
      {props.state.step === "provider" ? (
        <SelectionList
          title="Choose a provider"
          subtitle="Use up/down and Enter. Escape cancels."
          rows={providerOptions.map((option) => ({
            label: option.label,
            description: option.description
          }))}
          selectedIndex={props.selectedIndex}
        />
      ) : null}
      {props.state.step === "gemini-key" ? (
        <Box flexDirection="column" marginTop={2}>
          <Text color="white" bold>
            Enter your Gemini API key
          </Text>
          <Text color="gray">It will be stored in PatchPilot&apos;s own config directory, not in the repository.</Text>
          <Box marginTop={1}>
            <Text color="cyan">key &gt; </Text>
            <TextInput value={props.input} onChange={props.onInputChange} onSubmit={props.onInputSubmit} mask="*" />
          </Box>
        </Box>
      ) : null}
      {props.state.step === "codex-login" ? (
        <Box flexDirection="column" marginTop={2}>
          <Text color="white" bold>
            Connect Codex CLI
          </Text>
          <Text color="gray">Run `codex login` in another terminal, then press Enter here to continue.</Text>
          <Text color="gray">Escape goes back to provider selection.</Text>
        </Box>
      ) : null}
      {modelState ? (
        <SelectionList
          title={`Choose a ${modelState.provider} model`}
          subtitle="Use up/down and Enter. Left arrow goes back."
          rows={modelState.models.map((model) => ({
            label: model,
            description: model === modelState.models[props.selectedIndex] ? "selected" : "available"
          }))}
          selectedIndex={props.selectedIndex}
        />
      ) : null}
      <Box marginTop={1}>
        <Text color="gray">This setup window keeps onboarding separate from the chat transcript.</Text>
      </Box>
    </Box>
  );
}

function SelectionList(props: {
  title: string;
  subtitle: string;
  rows: Array<{ label: string; description: string }>;
  selectedIndex: number;
}): React.ReactElement {
  const startIndex = Math.max(0, Math.min(props.selectedIndex - 4, Math.max(0, props.rows.length - 8)));
  const visibleRows = props.rows.slice(startIndex, startIndex + 8);

  return (
    <Box flexDirection="column" marginTop={2}>
      <Text color="white" bold>
        {props.title}
      </Text>
      <Text color="gray">{props.subtitle}</Text>
      {visibleRows.map((row, index) => {
        const absoluteIndex = startIndex + index;
        const isSelected = absoluteIndex === props.selectedIndex;
        return (
          <Box key={`${absoluteIndex}-${row.label}`} marginTop={1}>
            <Box width={3}>
              <Text color={isSelected ? "cyan" : "gray"}>{isSelected ? ">" : " "}</Text>
            </Box>
            <Box width={28}>
              <Text color={isSelected ? "white" : "cyan"} bold={isSelected} wrap="truncate">
                {row.label}
              </Text>
            </Box>
            <Text color={isSelected ? "white" : "gray"} wrap="truncate">
              {row.description}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
