import React from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import type { ModelProvider } from "../../core/types.js";
import type { OllamaHost } from "../hosts.js";
import { selectableModels } from "../modelSelection.js";
import { symbols } from "../experimental/theme.js";
import {
  describePreferenceValue,
  preferenceRows,
  preferenceValueString,
  type OnboardingPreferences,
} from "../onboardingPreferences.js";

export type ApiKeyProvider = "gemini" | "gemini-wrapper" | "openrouter" | "nvidia";

export type OnboardingState =
  | {
      step: "welcome";
    }
  | {
      step: "entry";
    }
  | {
      step: "host";
      hosts: OllamaHost[];
    }
  | {
      step: "host-input";
    }
  | {
      step: "api-key-choice";
      provider: ApiKeyProvider;
      hasExistingKey: boolean;
    }
  | {
      step: "gemini-key";
    }
  | {
      step: "gemini-wrapper-url";
    }
  | {
      step: "gemini-wrapper-psid";
    }
  | {
      step: "gemini-wrapper-psidts";
      secure1psid: string;
    }
  | {
      step: "gemini-wrapper-model-mode";
    }
  | {
      step: "gemini-wrapper-key";
      baseUrl: string;
    }
  | {
      step: "openrouter-key";
    }
  | {
      step: "nvidia-key";
    }
  | {
      step: "codex-login";
    }
  | {
      step: "model";
      provider: ModelProvider;
      models: string[];
      deviceName?: string;
    }
  | {
      step: "preferences";
      provider: ModelProvider;
      model: string;
      preferences: OnboardingPreferences;
    };

const entryOptions = [
  {
    label: "This Device",
    description: "Run Ollama locally — fully offline, nothing leaves the machine"
  },
  {
    label: "Remote Host",
    description: "Reach Ollama on another LAN or Tailscale machine"
  },
  {
    label: "Gemini",
    description: "Google Gemini API — fast hosted models with an API key"
  },
  {
    label: "Gemini-Wrapper",
    description: "Local Gemini Web bridge driven by pasted browser cookies"
  },
  {
    label: "OpenRouter",
    description: "One key, many models — including auto-routed and free tiers"
  },
  {
    label: "NVIDIA",
    description: "NVIDIA NIM OpenAI-compatible inference endpoints"
  },
  {
    label: "Codex",
    description: "Sign in with your ChatGPT account through the Codex CLI"
  }
];

const stepFlow = ["workflow", "host", "auth", "model", "tune"] as const;

export function OnboardingPanel(props: {
  state: OnboardingState;
  height: number;
  selectedIndex: number;
  input: string;
  busyMessage?: string | null;
  notice?: {
    tone: "warning" | "danger" | "success";
    text: string;
    detail?: string;
  } | null;
  formatModelLabel?: (model: string) => string;
  formatModelDescription?: (model: string) => string;
  onInputChange: (value: string) => void;
  onInputSubmit: (value: string) => void;
}): React.ReactElement {
  const currentStepIndex =
    props.state.step === "welcome" || props.state.step === "entry"
      ? 0
      : props.state.step === "host" || props.state.step === "host-input"
        ? 1
        : props.state.step === "api-key-choice" || props.state.step === "gemini-key" || props.state.step === "gemini-wrapper-url" || props.state.step === "gemini-wrapper-psid" || props.state.step === "gemini-wrapper-psidts" || props.state.step === "gemini-wrapper-model-mode" || props.state.step === "gemini-wrapper-key" || props.state.step === "openrouter-key" || props.state.step === "nvidia-key" || props.state.step === "codex-login"
          ? 2
          : props.state.step === "model"
            ? 3
            : 4;
  const formatModelLabel = props.formatModelLabel ?? ((model: string) => model);
  const formatModelDescription = props.formatModelDescription ?? (() => "");
  const visibleModels = props.state.step === "model" ? selectableModels(props.input, props.state.models, formatModelLabel) : [];
  const selectedModel = props.state.step === "model" ? visibleModels[props.selectedIndex] ?? null : null;

  return (
    <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1} height={props.height} overflowY="hidden">
      <Box flexDirection="row">
        <Text color="cyan" bold>
          {symbols.assistant} PatchPilot
        </Text>
        <Text color="gray"> — first-run setup</Text>
      </Box>
      <Text color="gray">A few quick choices, then you are ready to ship. {symbols.bullet} reopen anytime with /onboarding</Text>
      <Box marginTop={1} flexDirection="row">
        {stepFlow.map((step, index) => {
          const done = index < currentStepIndex;
          const active = index === currentStepIndex;
          const glyph = done ? symbols.todoDone : active ? symbols.todoActive : symbols.todoPending;
          const color = done ? "green" : active ? "cyan" : "gray";
          return (
            <Text key={step} color={color} bold={active}>
              {index > 0 ? "  " : ""}
              {glyph} {step}
            </Text>
          );
        })}
      </Box>
      {props.busyMessage ? (
        <Box marginTop={1}>
          <Text color="yellow">{symbols.status} {props.busyMessage}</Text>
        </Box>
      ) : null}
      {props.notice ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={props.notice.tone === "success" ? "green" : props.notice.tone === "warning" ? "yellow" : "red"}>
            {props.notice.tone === "success" ? symbols.final : props.notice.tone === "warning" ? symbols.approval : symbols.error} {props.notice.text}
          </Text>
          {props.notice.detail ? <Text color="gray">  {props.notice.detail}</Text> : null}
        </Box>
      ) : null}
      {props.state.step === "welcome" ? (
        <WelcomeStep />
      ) : null}
      {props.state.step === "entry" ? (
        <SelectionList
          title="Where should the model run?"
          subtitle={`${symbols.arrow} up/down to move  ${symbols.bullet}  enter to pick  ${symbols.bullet}  esc skips setup`}
          rows={entryOptions}
          selectedIndex={props.selectedIndex}
        />
      ) : null}
      {props.state.step === "host" ? (
        <SelectionList
          title="Choose a host"
          subtitle={`Top row enters a host by hand  ${symbols.bullet}  ${symbols.arrow} left goes back`}
          rows={[
            {
              label: "Enter Host Manually",
              description: "Type a LAN IP, Tailscale IP, MagicDNS name, or full URL"
            },
            ...props.state.hosts.map((host) => ({
              label: host.deviceName,
              description: `${host.kind}  ${host.url}${host.version ? `  Ollama ${host.version}` : ""}`
            }))
          ]}
          selectedIndex={props.selectedIndex}
        />
      ) : null}
      {props.state.step === "host-input" ? (
        <InputStep
          title="Connect to a host"
          description="Enter a LAN IP, Tailscale IP, MagicDNS name, or full URL."
          prompt="host > "
          value={props.input}
          onChange={props.onInputChange}
          onSubmit={props.onInputSubmit}
        />
      ) : null}
      {props.state.step === "api-key-choice" ? (
        <SelectionList
          title={props.state.provider === "gemini-wrapper" ? "Gemini-Wrapper bridge auth" : `${providerLabel(props.state.provider)} API key`}
          subtitle={props.state.provider === "gemini-wrapper" ? "Saved cookies stay in PatchPilot config, never the repo." : "Existing keys stay in PatchPilot config, never the repo."}
          rows={[
            ...(props.state.hasExistingKey
              ? [
                  {
                    label: props.state.provider === "gemini-wrapper" ? "Use Saved Bridge" : "Use Existing Key",
                    description: props.state.provider === "gemini-wrapper" ? "Continue with the saved cookie file" : "Continue with the saved key"
                  }
                ]
              : []),
            ...(props.state.provider === "gemini-wrapper"
              ? [
                  {
                    label: "Import From Browser",
                    description: "Read Gemini Web cookies locally after this explicit choice"
                  }
                ]
              : []),
            {
              label: props.state.provider === "gemini-wrapper" ? "Paste Cookie" : "Enter New Key",
              description: props.state.provider === "gemini-wrapper" ? "Replace the Gemini Web cookie file in PatchPilot config" : "Replace or add the key in PatchPilot config"
            }
          ]}
          selectedIndex={props.selectedIndex}
        />
      ) : null}
      {props.state.step === "gemini-key" ? (
        <InputStep
          title="Enter your Gemini API key"
          description="Stored in PatchPilot's config directory, never in the repository."
          prompt="key  > "
          value={props.input}
          onChange={props.onInputChange}
          onSubmit={props.onInputSubmit}
          mask="*"
        />
      ) : null}
      {props.state.step === "gemini-wrapper-url" ? (
        <InputStep
          title="Connect Gemini-Wrapper HTTP"
          description="Optional advanced mode: enter an explicit OpenAI-compatible wrapper URL."
          prompt="url  > "
          value={props.input}
          onChange={props.onInputChange}
          onSubmit={props.onInputSubmit}
        />
      ) : null}
      {props.state.step === "gemini-wrapper-psid" ? (
        <InputStep
          title="Connect Gemini-API bridge"
          description="Paste __Secure-1PSID. PatchPilot stores it in ~/.patchpilot/gemini-cookies.json with owner-only permissions."
          prompt="psid > "
          value={props.input}
          onChange={props.onInputChange}
          onSubmit={props.onInputSubmit}
          mask="*"
        />
      ) : null}
      {props.state.step === "gemini-wrapper-psidts" ? (
        <InputStep
          title="Optional Gemini session timestamp"
          description="Paste __Secure-1PSIDTS if you have it, or press Enter to skip."
          prompt="ts   > "
          value={props.input}
          onChange={props.onInputChange}
          onSubmit={props.onInputSubmit}
          mask="*"
        />
      ) : null}
      {props.state.step === "gemini-wrapper-model-mode" ? (
        <SelectionList
          title="Gemini-Wrapper model"
          subtitle="Shortcuts resolve through live Gemini Web discovery; Denkaufwand is not a stable bridge control yet."
          rows={[
            {
              label: "Auto",
              description: "Let Gemini Web pick the current default model"
            },
            {
              label: "Flash-Lite",
              description: "Resolve the live Gemini Web Flash-Lite model"
            },
            {
              label: "Flash",
              description: "Resolve the live Flash model, preferring 3.5 Flash when the bridge lists it"
            },
            {
              label: "Pro",
              description: "Resolve the live Gemini Web Pro model"
            },
            {
              label: "Manual",
              description: "Fetch available Gemini Web models and choose one"
            }
          ]}
          selectedIndex={props.selectedIndex}
        />
      ) : null}
      {props.state.step === "gemini-wrapper-key" ? (
        <InputStep
          title="Enter Gemini-Wrapper API key"
          description="Required for remote wrapper URLs. Local wrapper URLs may leave this empty."
          prompt="key  > "
          value={props.input}
          onChange={props.onInputChange}
          onSubmit={props.onInputSubmit}
          mask="*"
        />
      ) : null}
      {props.state.step === "openrouter-key" ? (
        <InputStep
          title="Enter your OpenRouter API key"
          description="Stored in PatchPilot's config directory, never in the repository."
          prompt="key  > "
          value={props.input}
          onChange={props.onInputChange}
          onSubmit={props.onInputSubmit}
          mask="*"
        />
      ) : null}
      {props.state.step === "nvidia-key" ? (
        <InputStep
          title="Enter your NVIDIA API key"
          description="Stored in PatchPilot's config directory, never in the repository."
          prompt="key  > "
          value={props.input}
          onChange={props.onInputChange}
          onSubmit={props.onInputSubmit}
          mask="*"
        />
      ) : null}
      {props.state.step === "codex-login" ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="white" bold>
            {symbols.arrow} Connect Codex CLI
          </Text>
          <Text color="gray">Run `codex login` in another terminal, then press Enter here to continue.</Text>
          <Text color="gray">{symbols.bullet} esc or left arrow goes back</Text>
        </Box>
      ) : null}
      {props.state.step === "model" ? (
        <>
          <InputStep
            title={`Choose a ${props.state.provider} model${props.state.deviceName ? ` on ${props.state.deviceName}` : ""}`}
            description="Type to filter. Up/down to move, enter to pick. Left arrow goes back."
            prompt="find > "
            value={props.input}
            onChange={props.onInputChange}
            onSubmit={props.onInputSubmit}
          />
          <SelectionList
            title=""
            subtitle={`${visibleModels.length} matching model${visibleModels.length === 1 ? "" : "s"}`}
            rows={visibleModels.map((model) => ({
              label: formatModelLabel(model),
              description: `${model === selectedModel ? "selected" : "available"}${formatModelDescription(model)}`
            }))}
            selectedIndex={props.selectedIndex}
          />
        </>
      ) : null}
      {props.state.step === "preferences" ? (
        <PreferencesStep
          provider={props.state.provider}
          model={props.state.model}
          preferences={props.state.preferences}
          selectedIndex={props.selectedIndex}
        />
      ) : null}
      <Box marginTop={1}>
        <Text color="gray">
          {symbols.info} Remote inference keeps file reads, writes, shell, Git, and tests on this device — only the model call moves.
        </Text>
      </Box>
    </Box>
  );
}

function WelcomeStep(): React.ReactElement {
  return (
    <Box marginTop={1} flexDirection="column">
      <Text color="cyan" bold>{symbols.assistant} A coding agent you can watch work</Text>
      <Text color="gray">Local-first. Every read, write, command, and model route stays visible and inspectable.</Text>
      <Box marginTop={1} flexDirection="column">
        <Text color="white">{symbols.todoActive} Plan {symbols.bullet} read files, map the architecture, keep a live todo list</Text>
        <Text color="white">{symbols.todoActive} Build {symbols.bullet} scoped approvals for edits, scripts, tests, and shell</Text>
        <Text color="white">{symbols.todoActive} Review {symbols.bullet} show diffs, run checks, leave Git history ready for you</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color="yellow">{symbols.pin} First task to try: "summarize this repo and list the safest next fixes"</Text>
        <Text color="gray">{symbols.arrow} enter continues {symbols.bullet} esc skips {symbols.bullet} reopen later with /onboarding</Text>
      </Box>
    </Box>
  );
}

function providerLabel(provider: ApiKeyProvider): string {
  return provider === "openrouter" ? "OpenRouter" : provider === "nvidia" ? "NVIDIA" : provider === "gemini-wrapper" ? "Gemini-Wrapper" : "Gemini";
}

function PreferencesStep(props: {
  provider: ModelProvider;
  model: string;
  preferences: OnboardingPreferences;
  selectedIndex: number;
}): React.ReactElement {
  const rows = preferenceRows;
  const confirmIndex = rows.length;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="white" bold>
        Tune your defaults
      </Text>
      <Text color="gray">
        {symbols.final} {props.provider} {symbols.bullet} {props.model}
      </Text>
      <Text color="gray">
        {symbols.arrow} up/down to move {symbols.bullet} left/right to change {symbols.bullet} enter to finish
      </Text>
      {rows.map((row, index) => {
        const isSelected = index === props.selectedIndex;
        const value = preferenceValueString(props.preferences, row.key);
        return (
          <Box key={row.key} marginTop={1} flexDirection="column">
            <Box flexDirection="row">
              <Box width={3}>
                <Text color={isSelected ? "cyan" : "gray"}>{isSelected ? symbols.todoActive : " "}</Text>
              </Box>
              <Box width={30}>
                <Text color={isSelected ? "white" : "gray"} bold={isSelected}>
                  {row.label}
                </Text>
              </Box>
              <Text color={isSelected ? "cyan" : "gray"} bold>
                {isSelected ? `${symbols.arrow} ` : "  "}
                {value}
              </Text>
            </Box>
            {isSelected ? (
              <Box marginLeft={3}>
                <Text color="gray">{describePreferenceValue(row.key, value)}</Text>
              </Box>
            ) : null}
          </Box>
        );
      })}
      <Box marginTop={1} flexDirection="row">
        <Box width={3}>
          <Text color={props.selectedIndex === confirmIndex ? "green" : "gray"}>
            {props.selectedIndex === confirmIndex ? symbols.todoActive : " "}
          </Text>
        </Box>
        <Text color={props.selectedIndex === confirmIndex ? "green" : "gray"} bold={props.selectedIndex === confirmIndex}>
          {symbols.final} Finish setup and start session
        </Text>
      </Box>
    </Box>
  );
}

function InputStep(props: {
  title: string;
  description: string;
  prompt: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  mask?: string;
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="white" bold>
        {props.title}
      </Text>
      <Text color="gray">{props.description}</Text>
      <Box marginTop={1}>
        <Text color="cyan">{symbols.user} {props.prompt}</Text>
        <TextInput value={props.value} onChange={props.onChange} onSubmit={props.onSubmit} mask={props.mask} />
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
  const endIndex = startIndex + visibleRows.length;

  return (
    <Box flexDirection="column" marginTop={1}>
      {props.title ? (
        <Text color="white" bold>
          {props.title}
        </Text>
      ) : null}
      <Text color="gray">
        {props.subtitle} {props.rows.length > 0 ? `${startIndex + 1}-${endIndex}/${props.rows.length}` : "0/0"}
      </Text>
      {visibleRows.map((row, index) => {
        const absoluteIndex = startIndex + index;
        const isSelected = absoluteIndex === props.selectedIndex;
        return (
          <Box key={`${absoluteIndex}-${row.label}`} marginTop={1}>
            <Box width={3}>
              <Text color={isSelected ? "cyan" : "gray"}>{isSelected ? symbols.todoActive : " "}</Text>
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
