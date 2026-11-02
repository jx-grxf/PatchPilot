import React from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import type { ModelCapabilities } from "../../core/capability.js";
import type { ModelProvider } from "../../core/types.js";
import type { OllamaHost } from "../hosts.js";
import { selectableModels } from "../modelSelection.js";
import { symbols } from "../shell/theme.js";
import {
  describePreferenceValue,
  preferenceRows,
  preferenceValueString,
  type OnboardingPreferences,
} from "../onboardingPreferences.js";
import { starterKeys, starterPrompts, type InstallGuide, type RuntimeChoice } from "../onboardingSetup.js";

export type OnboardingState =
  | {
      step: "welcome";
    }
  | {
      step: "disclaimer";
    }
  | {
      step: "entry";
      /** Null while the runtimes are being probed. */
      choices: RuntimeChoice[] | null;
    }
  | {
      step: "install";
      guide: InstallGuide;
    }
  | {
      step: "host";
      hosts: OllamaHost[];
    }
  | {
      step: "host-input";
    }
  | {
      step: "local-url";
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
    }
  | {
      step: "ready";
      provider: ModelProvider;
      model: string;
      /** Null while the tool-call check is still running. */
      probe: ModelCapabilities | null;
    };

const stepFlow = ["start", "runtime", "model", "defaults", "check"] as const;

export function OnboardingPanel(props: {
  state: OnboardingState;
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
  const currentStepIndex = stepIndex(props.state.step);
  const formatModelLabel = props.formatModelLabel ?? ((model: string) => model);
  const formatModelDescription = props.formatModelDescription ?? (() => "");
  const visibleModels = props.state.step === "model" ? selectableModels(props.input, props.state.models, formatModelLabel) : [];

  return (
    // Sits in the live region under the transcript, like every other panel:
    // replacing the whole shell remounted the static transcript and printed
    // the session a second time.
    <Box borderStyle="round" borderColor="gray" flexDirection="column" paddingX={1} marginTop={1}>
      <Box flexDirection="row">
        <Text bold>Setup</Text>
        <Text color="gray">  esc skips {symbols.bullet} /onboarding reopens it</Text>
      </Box>
      <Box flexDirection="row">
        {stepFlow.map((step, index) => {
          const done = index < currentStepIndex;
          const active = index === currentStepIndex;
          const color = done ? "green" : active ? "white" : "gray";
          return (
            <Text key={step} color={color} bold={active}>
              {index > 0 ? <Text color="gray"> {symbols.arrow} </Text> : ""}
              {done ? `${symbols.todoDone} ` : ""}
              {step}
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
      {props.state.step === "disclaimer" ? (
        <DisclaimerStep />
      ) : null}
      {props.state.step === "entry" && props.state.choices ? (
        <SelectionList
          title="Where should the model run?"
          subtitle={`${symbols.arrow} up/down to move  ${symbols.bullet}  enter to pick  ${symbols.bullet}  esc skips setup`}
          rows={props.state.choices}
          selectedIndex={props.selectedIndex}
          labelWidth={28}
        />
      ) : null}
      {props.state.step === "install" ? <InstallStepView guide={props.state.guide} /> : null}
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
      {props.state.step === "local-url" ? (
        <InputStep
          title="Connect a model server"
          description="LM Studio, llama.cpp, vLLM or any OpenAI-compatible server. Paste its base URL, or press enter for the default."
          prompt="url  > "
          value={props.input}
          onChange={props.onInputChange}
          onSubmit={props.onInputSubmit}
        />
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
              description: formatModelDescription(model).replace(/^[\s·,-]+/, "")
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
      {props.state.step === "ready" ? (
        <ReadyStep provider={props.state.provider} model={props.state.model} probe={props.state.probe} />
      ) : null}
    </Box>
  );
}

function stepIndex(step: OnboardingState["step"]): number {
  switch (step) {
    case "welcome":
    case "disclaimer":
      return 0;
    case "entry":
    case "install":
    case "host":
    case "host-input":
    case "local-url":
      return 1;
    case "model":
      return 2;
    case "preferences":
      return 3;
    case "ready":
      return 4;
  }
}

function InstallStepView(props: { guide: InstallGuide }): React.ReactElement {
  return (
    <Box marginTop={1} flexDirection="column">
      <Text color="white" bold>Install a model runtime</Text>
      <Text color="gray">PatchPilot runs the model on your own machine. On {props.guide.system}, Ollama is the quickest start:</Text>
      {props.guide.steps.map((step, index) => (
        <Box key={step.text} marginTop={1} flexDirection="column">
          <Text color="white">{index + 1}. {step.text}</Text>
          {step.command ? <Text color="cyan">   {step.command}</Text> : null}
        </Box>
      ))}
      <Box marginTop={1} flexDirection="column">
        <Text color="gray">Other options:</Text>
        {props.guide.alternatives.map((step) => (
          <Box key={step.text} flexDirection="column">
            <Text color="gray">{symbols.bullet} {step.text}</Text>
            {step.command ? <Text color="cyan">   {step.command}</Text> : null}
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color="cyan" bold>enter checks again</Text>
        <Text color="gray">  {symbols.bullet}  esc goes back</Text>
      </Box>
    </Box>
  );
}

function ReadyStep(props: { provider: ModelProvider; model: string; probe: ModelCapabilities | null }): React.ReactElement {
  const failed = props.probe?.detail.startsWith("probe failed") ?? false;
  return (
    <Box marginTop={1} flexDirection="column">
      <Text color="white" bold>{props.model}</Text>
      {props.probe === null ? (
        <Text color="yellow">{symbols.status} Checking that the model can call tools. The first answer loads it into memory, which can take a minute.</Text>
      ) : props.probe.nativeToolCalls ? (
        <Text color="green">{symbols.final} Tool calling works.</Text>
      ) : failed ? (
        <Box flexDirection="column">
          <Text color="red">{symbols.error} The model server did not answer.</Text>
          <Text color="gray">  {props.probe.detail.replace(/^probe failed:\s*/, "")}</Text>
          <Text color="gray">  Check that the server is still running. /onboarding runs this setup again.</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text color="yellow">{symbols.approval} This model answered without calling a tool.</Text>
          <Text color="gray">  PatchPilot falls back to a JSON protocol, which works but is slower. A model with tool support works better.</Text>
        </Box>
      )}
      <Box marginTop={1} flexDirection="column">
        <Text color="white">Things to try:</Text>
        {starterPrompts.map((prompt) => (
          <Text key={prompt} color="cyan">  "{prompt}"</Text>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {starterKeys.map((entry) => (
          <Box key={entry.key}>
            <Box width={10}>
              <Text color="white">  {entry.key}</Text>
            </Box>
            <Text color="gray">{entry.text}</Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color="green" bold>{symbols.final} enter starts the session</Text>
      </Box>
    </Box>
  );
}

function WelcomeStep(): React.ReactElement {
  return (
    <Box marginTop={1} flexDirection="column">
      <Text color="cyan" bold>{symbols.assistant} A coding agent you can watch work</Text>
      <Text color="gray">The model runs on your machine or one you own. Every read, edit and command shows up in the transcript.</Text>
      <Box marginTop={1} flexDirection="column">
        <Text color="white">{symbols.todoActive} Plan {symbols.bullet} read files, map the architecture, keep a live todo list</Text>
        <Text color="white">{symbols.todoActive} Build {symbols.bullet} scoped approvals for edits, scripts, tests, and shell</Text>
        <Text color="white">{symbols.todoActive} Review {symbols.bullet} show diffs, run checks, leave Git history ready for you</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="gray">{symbols.arrow} enter continues {symbols.bullet} esc skips {symbols.bullet} reopen later with /onboarding</Text>
      </Box>
    </Box>
  );
}

function DisclaimerStep(): React.ReactElement {
  return (
    <Box marginTop={1} flexDirection="column">
      <Text color="yellow" bold>{symbols.approval} Use at your own risk</Text>
      <Text color="gray">PatchPilot can read files, edit files, and run shell commands when you enable those capabilities.</Text>
      <Text color="gray">You remain responsible for reviewing actions, diffs, commands, provider terms, and generated output.</Text>
      <Text color="gray">The software is provided as-is, without warranty or liability from the maintainer.</Text>
      <Box marginTop={1}>
        <Text color="cyan" bold>Press [y] to accept and continue</Text>
        <Text color="gray">  {symbols.bullet}  Esc goes back</Text>
      </Box>
    </Box>
  );
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
  labelWidth?: number;
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
          <Box key={`${absoluteIndex}-${row.label}`}>
            <Box width={2} flexShrink={0}>
              <Text color={isSelected ? "cyan" : "gray"}>{isSelected ? symbols.user : " "}</Text>
            </Box>
            <Box width={props.labelWidth ?? 44} flexShrink={0}>
              <Text color={isSelected ? "cyan" : "white"} bold={isSelected} wrap="truncate">
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
