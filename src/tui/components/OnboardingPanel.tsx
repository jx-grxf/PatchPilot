import React from "react";
import { Box, Text } from "ink";
import type { ModelProvider } from "../../core/types.js";

export type OnboardingState =
  | {
      step: "provider";
    }
  | {
      step: "gemini-key";
    }
  | {
      step: "model";
      provider: ModelProvider;
      models: string[];
    };

export function OnboardingPanel(props: { state: OnboardingState | null }): React.ReactElement | null {
  if (!props.state) {
    return null;
  }

  return (
    <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1} marginTop={1}>
      <Text color="cyan" bold>
        Onboarding
      </Text>
      {props.state.step === "provider" ? (
        <>
          <Text color="gray">Choose provider:</Text>
          <Text color="gray">1. Ollama - local or LAN model server</Text>
          <Text color="gray">2. Gemini - Google Gemini API key from .env</Text>
        </>
      ) : null}
      {props.state.step === "gemini-key" ? (
        <>
          <Text color="gray">Paste your Gemini API key.</Text>
          <Text color="gray">PatchPilot saves it to .env as GEMINI_API_KEY and masks the input.</Text>
        </>
      ) : null}
      {props.state.step === "model" ? (
        <>
          <Text color="gray">Choose a {props.state.provider} model by number or name:</Text>
          {props.state.models.slice(0, 12).map((model, index) => (
            <Text key={model} color="gray">
              {index + 1}. {model}
            </Text>
          ))}
        </>
      ) : null}
    </Box>
  );
}
