import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, useApp, useInput, useStdout } from "ink";
import { AgentRunner, type AgentRunnerOptions } from "../core/agent.js";
import { defaultCodexModel, hasCodexCliOAuth } from "../core/codex.js";
import { describeComputeTarget } from "../core/compute.js";
import { runDoctor } from "../core/doctor.js";
import { savePatchPilotEnvValues } from "../core/env.js";
import { defaultGeminiModel } from "../core/gemini.js";
import { createModelClient } from "../core/modelClient.js";
import { defaultOllamaModel, OllamaClient } from "../core/ollama.js";
import { defaultOpenRouterModel, isOpenRouterFreeModel } from "../core/openrouter.js";
import { addTelemetryToSession, emptySessionTelemetry, estimateTokens } from "../core/tokenAccounting.js";
import type { AgentEvent, ModelProvider, ModelTelemetry, SessionTelemetry } from "../core/types.js";
import { CommandSuggestions, type CommandSuggestionItem } from "./components/CommandSuggestions.js";
import { Composer, FooterHints } from "./components/Composer.js";
import { Header } from "./components/Header.js";
import { OnboardingPanel, type OnboardingState } from "./components/OnboardingPanel.js";
import { Sidebar } from "./components/Sidebar.js";
import { Transcript } from "./components/Transcript.js";
import { filterSlashCommands, formatCommandDetail } from "./commands.js";
import { formatCost, formatSessionTokens, formatTokens, normalizeModelAlias, readToggle } from "./format.js";
import { checkOllamaHost, discoverOllamaHosts, normalizeOllamaUrl, readOllamaHostDetails, startLocalOllamaAppAndWait, type OllamaHost, type OllamaHostDetails } from "./hosts.js";
import { readGpuStats, readSystemStats, type GpuStats, type SystemStats } from "./systemStats.js";
import { maxTranscriptLines, type AdvisorNote, type AgentMode, type LogLine } from "./types.js";

export type PatchPilotAppProps = AgentRunnerOptions & {
  initialTask?: string;
};

type PaletteSuggestion = CommandSuggestionItem & {
  command: string;
  execute: boolean;
};

const modelCacheTtlMs = 5 * 60_000;
const modelCache = new Map<string, { models: string[]; expiresAt: number }>();

export function App(props: PatchPilotAppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [input, setInput] = useState(props.initialTask ?? "");
  const didRunInitialTask = useRef(false);
  const didOpenDefaultOnboarding = useRef(false);
  const usedOllamaModelsRef = useRef(new Set<string>());
  const [lines, setLines] = useState<LogLine[]>([]);
  const [advisorNotes, setAdvisorNotes] = useState<AdvisorNote[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState("idle");
  const [telemetry, setTelemetry] = useState<ModelTelemetry | null>(null);
  const [sessionTelemetry, setSessionTelemetry] = useState<SessionTelemetry>(() => emptySessionTelemetry());
  const [systemStats, setSystemStats] = useState<SystemStats>(() => readSystemStats().stats);
  const [gpuStats, setGpuStats] = useState<GpuStats | null>(null);
  const [agentMode, setAgentMode] = useState<AgentMode>(props.allowWrite || props.allowShell ? "build" : "plan");
  const [hostOptions, setHostOptions] = useState<OllamaHost[]>([]);
  const [activeHost, setActiveHost] = useState<OllamaHostDetails | null>(null);
  const [isLoadingHosts, setIsLoadingHosts] = useState(false);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  const [onboardingIndex, setOnboardingIndex] = useState(0);
  const [onboardingInput, setOnboardingInput] = useState("");
  const [onboardingBusyMessage, setOnboardingBusyMessage] = useState<string | null>(null);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [activeScrollPane, setActiveScrollPane] = useState<"transcript" | "session">("transcript");
  const [transcriptScrollOffset, setTranscriptScrollOffset] = useState(0);
  const [sessionScrollOffset, setSessionScrollOffset] = useState(0);
  const [settings, setSettings] = useState<AgentRunnerOptions>({
    provider: props.provider,
    model: props.model,
    ollamaUrl: props.ollamaUrl,
    workspace: props.workspace,
    allowWrite: props.allowWrite,
    allowShell: props.allowShell,
    maxSteps: props.maxSteps,
    thinkingMode: props.thinkingMode,
    subagents: props.subagents
  });
  const draftTokens = estimateTokens(input);
  const terminalRows = stdout.rows ?? 40;
  const terminalColumns = stdout.columns ?? 120;
  const paletteItems =
    !isRunning && !onboarding
      ? buildCommandSuggestionItems({
          input,
          provider: settings.provider,
          hostOptions,
          modelOptions,
          currentModel: settings.model,
          isLoadingHosts,
          isLoadingModels
        })
      : [];
  const rootHeight = Math.max(24, terminalRows);
  const headerReservedHeight = 7;
  const paletteReservedHeight = !onboarding && paletteItems.length > 0 ? 4 : 0;
  const composerReservedHeight = onboarding ? 0 : 3;
  const footerReservedHeight = onboarding ? 0 : 1;
  const panelHeight = Math.max(8, rootHeight - headerReservedHeight - composerReservedHeight - paletteReservedHeight - footerReservedHeight);
  const transcriptWidth = Math.max(42, terminalColumns - 38);
  const scrollStep = Math.max(4, Math.floor(panelHeight * 0.8));
  const appendLine = useCallback((line: Omit<LogLine, "id">) => {
    setLines((currentLines) => [
      ...currentLines.slice(-maxTranscriptLines),
      {
        ...line,
        id: Date.now() + Math.random()
      }
    ]);
  }, []);

  const applyMode = useCallback(
    (nextMode: AgentMode, announce = true) => {
      setAgentMode(nextMode);
      setSettings((currentSettings) => ({
        ...currentSettings,
        allowWrite: nextMode === "build" ? currentSettings.allowWrite : false,
        allowShell: nextMode === "build" ? currentSettings.allowShell : false
      }));

      if (announce) {
        appendLine({
          tone: "success",
          label: "mode",
          text: `${nextMode} mode ${nextMode === "plan" ? "keeps tools read-only" : "uses enabled write/shell permissions"}`
        });
      }
    },
    [appendLine]
  );

  const toggleMode = useCallback(() => {
    applyMode(agentMode === "plan" ? "build" : "plan");
  }, [agentMode, applyMode]);

  const loadHostSuggestions = useCallback(
    async (refresh = false, announce = false): Promise<OllamaHost[]> => {
      if (isLoadingHosts) {
        return hostOptions;
      }

      setIsLoadingHosts(true);
      try {
        const hosts = await discoverOllamaHosts(settings.ollamaUrl, {
          refresh
        });
        setHostOptions(hosts);
        if (announce) {
          appendLine({
            tone: hosts.length > 0 ? "accent" : "warning",
            label: "hosts",
            text:
              hosts.length > 0
                ? `Found ${hosts.length} Ollama host${hosts.length === 1 ? "" : "s"}. Pick one with /connect or the command palette.`
                : "No reachable Ollama hosts found.",
            detail:
              hosts.length > 0
                ? formatHostOptions(hosts)
                : "PatchPilot scanned the local LAN and Tailscale peers. Try /connect <host> for a manual URL or MagicDNS name."
          });
        }
        return hosts;
      } finally {
        setIsLoadingHosts(false);
      }
    },
    [appendLine, hostOptions, isLoadingHosts, settings.ollamaUrl]
  );

  const loadProviderModels = useCallback(
    async (refresh = false): Promise<string[]> => {
      if (isLoadingModels) {
        return modelOptions;
      }

      setIsLoadingModels(true);
      try {
        return await loadAvailableModels(settings.provider, settings.ollamaUrl, setModelOptions, refresh);
      } finally {
        setIsLoadingModels(false);
      }
    },
    [isLoadingModels, modelOptions, settings.ollamaUrl, settings.provider]
  );

  const connectToHost = useCallback(
    async (
      value: string | OllamaHost,
      options: {
        announce?: boolean;
      } = {}
    ): Promise<OllamaHostDetails | null> => {
      const candidate = typeof value === "string" ? null : value;
      const nextUrl = typeof value === "string" ? normalizeOllamaUrl(value) : value.url;
      const verifiedHost = await checkOllamaHost(nextUrl, {
        ...candidate,
        timeoutMs: 1200
      });

      if (!verifiedHost) {
        if (options.announce !== false) {
          appendLine({
            tone: "warning",
            label: "ollama",
            text: `No Ollama server answered at ${nextUrl}.`,
            detail: "Check the IP, MagicDNS name, firewall rules, and whether Ollama is listening on the remote machine."
          });
        }
        return null;
      }

      const details = await readOllamaHostDetails(verifiedHost, true).catch(() => ({
        host: verifiedHost,
        models: [] as string[],
        runningModels: [],
        fetchedAt: Date.now()
      }));

      setTelemetry(null);
      setActiveHost(details);
      setHostOptions((currentHosts) => [verifiedHost, ...currentHosts.filter((host) => host.url !== verifiedHost.url)]);
      setModelOptions(details.models);
      modelCache.set(`ollama:${verifiedHost.url}`, {
        models: details.models,
        expiresAt: Date.now() + modelCacheTtlMs
      });
      setSettings((currentSettings) => ({
        ...currentSettings,
        provider: "ollama",
        ollamaUrl: verifiedHost.url
      }));
      savePatchPilotEnvValues({
        PATCHPILOT_PROVIDER: "ollama",
        PATCHPILOT_OLLAMA_URL: verifiedHost.url
      });

      if (options.announce !== false) {
        appendLine({
          tone: "success",
          label: "ollama",
          text: `connected to ${verifiedHost.deviceName}`,
          detail: `Ollama ${verifiedHost.version ?? "unknown version"} at ${verifiedHost.url}. Only inference runs on this host; file reads, writes, shell, Git, and tests stay on this device.`
        });

        if (details.models.length > 0 && !details.models.includes(settings.model)) {
          appendLine({
            tone: "warning",
            label: "model",
            text: `${settings.model} is not available on ${verifiedHost.deviceName}.`,
            detail: `Pick a host model with /models. Available:\n${formatModelOptions(details.models, settings.model)}`
          });
        }
      }

      return details;
    },
    [appendLine, settings.model]
  );

  const openModelSelection = useCallback(
    async (
      provider: ModelProvider,
      options: {
        deviceName?: string;
        currentModel?: string;
        ollamaUrl?: string;
      } = {}
    ): Promise<void> => {
      setTelemetry(null);
      setOnboardingBusyMessage(`Loading ${provider} models...`);
      const nextModel = defaultModelForProvider(provider, options.currentModel ?? settings.model);
      setSettings((currentSettings) => ({
        ...currentSettings,
        provider,
        model: nextModel
      }));

      try {
        const models = await loadAvailableModels(provider, options.ollamaUrl ?? settings.ollamaUrl, setModelOptions, true);
        if (models.length === 0) {
          appendLine({
            tone: "warning",
            label: "onboarding",
            text:
              provider === "ollama"
                ? "No Ollama models found on that host."
                : provider === "gemini"
                  ? "No Gemini models listed. Check the API key."
                  : provider === "openrouter"
                    ? "No OpenRouter models listed. Check the API key."
                    : "No Codex OAuth models listed."
          });
          return;
        }

        setOnboarding({
          step: "model",
          provider,
          models,
          deviceName: options.deviceName
        });
        setOnboardingIndex(0);
      } catch (error) {
        appendLine({
          tone: "danger",
          label: "onboarding",
          text: error instanceof Error ? error.message : String(error)
        });
      } finally {
        setOnboardingBusyMessage(null);
      }
    },
    [appendLine, settings.model, settings.ollamaUrl]
  );

  const closeOnboarding = useCallback(() => {
    setOnboarding(null);
    setOnboardingIndex(0);
    setOnboardingInput("");
    setOnboardingBusyMessage(null);
  }, []);

  const goBackOnboarding = useCallback(() => {
    if (!onboarding) {
      return;
    }

    setOnboardingBusyMessage(null);
    setOnboardingInput("");
    setOnboardingIndex(0);

    switch (onboarding.step) {
      case "entry":
        setOnboarding(null);
        return;
      case "host":
      case "gemini-key":
      case "openrouter-key":
      case "codex-login":
        setOnboarding({
          step: "entry"
        });
        return;
      case "host-input":
        setOnboarding({
          step: "host",
          hosts: hostOptions
        });
        return;
      case "model":
        if (onboarding.provider === "ollama" && activeHost?.host.kind !== "local") {
          setOnboarding({
            step: "host",
            hosts: hostOptions
          });
          return;
        }

        if (onboarding.provider === "gemini") {
          setOnboarding({
            step: "gemini-key"
          });
          return;
        }

        if (onboarding.provider === "codex" && !hasCodexCliOAuth()) {
          setOnboarding({
            step: "codex-login"
          });
          return;
        }

        setOnboarding({
          step: "entry"
        });
    }
  }, [activeHost?.host.kind, hostOptions, onboarding]);

  const handleOnboardingSubmit = useCallback(
    async (value: string): Promise<void> => {
      if (!onboarding) {
        return;
      }

      if (onboarding.step === "entry") {
        const selection = readEntrySelection(value, onboardingIndex);
        if (!selection) {
          return;
        }

        if (selection === "local") {
          setOnboardingBusyMessage("Checking local Ollama...");
          let details = await connectToHost("local", {
            announce: false
          });
          if (!details && process.platform === "darwin") {
            setOnboardingBusyMessage("Starting Ollama.app and waiting for the local server...");
            const startedHost = await startLocalOllamaAppAndWait();
            details = startedHost ? await connectToHost(startedHost, { announce: false }) : null;
          }

          if (!details) {
            setOnboardingBusyMessage("Local Ollama is not reachable. Start Ollama.app or run `ollama serve`, then press Enter again.");
            appendLine({
              tone: "warning",
              label: "onboarding",
              text: "Local Ollama is not reachable.",
              detail: "Start Ollama.app or run `ollama serve`, then try again."
            });
            return;
          }

          await openModelSelection("ollama", {
            deviceName: details.host.deviceName,
            ollamaUrl: details.host.url
          });
          return;
        }

        if (selection === "host") {
          setOnboardingBusyMessage("Scanning LAN and Tailscale for Ollama hosts...");
          try {
            const hosts = await loadHostSuggestions(true, false);
            setOnboarding({
              step: "host",
              hosts
            });
            setOnboardingIndex(0);
          } finally {
            setOnboardingBusyMessage(null);
          }
          return;
        }

        if (selection === "gemini") {
          setOnboarding({
            step: "gemini-key"
          });
          setOnboardingInput("");
          return;
        }

        if (selection === "openrouter") {
          setOnboarding({
            step: "openrouter-key"
          });
          setOnboardingInput("");
          return;
        }

        if (!hasCodexCliOAuth()) {
          setOnboarding({
            step: "codex-login"
          });
          return;
        }

        await openModelSelection("codex");
        return;
      }

      if (onboarding.step === "host") {
        const selectionIndex = readIndexedSelection(value, onboardingIndex);
        if (selectionIndex === null) {
          return;
        }

        if (selectionIndex === 0) {
          setOnboarding({
            step: "host-input"
          });
          setOnboardingInput("");
          return;
        }

        const selectedHost = onboarding.hosts[selectionIndex - 1];
        if (!selectedHost) {
          appendLine({
            tone: "warning",
            label: "onboarding",
            text: "Unknown host selection."
          });
          return;
        }

        setOnboardingBusyMessage(`Connecting to ${selectedHost.deviceName}...`);
        const details = await connectToHost(selectedHost, {
          announce: false
        });
        if (!details) {
          setOnboardingBusyMessage(null);
          return;
        }

        await openModelSelection("ollama", {
          deviceName: details.host.deviceName,
          ollamaUrl: details.host.url
        });
        return;
      }

      if (onboarding.step === "host-input") {
        const hostValue = value.trim();
        if (!hostValue) {
          appendLine({
            tone: "warning",
            label: "onboarding",
            text: "Host cannot be empty."
          });
          return;
        }

        setOnboardingBusyMessage(`Connecting to ${hostValue}...`);
        const details = await connectToHost(hostValue, {
          announce: false
        });
        if (!details) {
          setOnboardingBusyMessage(null);
          return;
        }

        await openModelSelection("ollama", {
          deviceName: details.host.deviceName,
          ollamaUrl: details.host.url
        });
        return;
      }

      if (onboarding.step === "gemini-key") {
        const apiKey = value.trim();
        if (!apiKey) {
          appendLine({
            tone: "warning",
            label: "onboarding",
            text: "Gemini API key cannot be empty."
          });
          return;
        }

        process.env.GEMINI_API_KEY = apiKey;
        savePatchPilotEnvValues({
          PATCHPILOT_PROVIDER: "gemini",
          PATCHPILOT_MODEL: defaultGeminiModel,
          GEMINI_API_KEY: apiKey
        });
        appendLine({
          tone: "success",
          label: "onboarding",
          text: "Gemini API key saved to PatchPilot config."
        });
        await openModelSelection("gemini", {
          currentModel: defaultGeminiModel
        });
        return;
      }

      if (onboarding.step === "openrouter-key") {
        const apiKey = value.trim();
        if (!apiKey) {
          appendLine({
            tone: "warning",
            label: "onboarding",
            text: "OpenRouter API key cannot be empty."
          });
          return;
        }

        process.env.OPENROUTER_API_KEY = apiKey;
        savePatchPilotEnvValues({
          PATCHPILOT_PROVIDER: "openrouter",
          PATCHPILOT_MODEL: defaultOpenRouterModel,
          OPENROUTER_API_KEY: apiKey
        });
        appendLine({
          tone: "success",
          label: "onboarding",
          text: "OpenRouter API key saved to PatchPilot config."
        });
        await openModelSelection("openrouter", {
          currentModel: defaultOpenRouterModel
        });
        return;
      }

      if (onboarding.step === "codex-login") {
        if (!hasCodexCliOAuth()) {
          appendLine({
            tone: "warning",
            label: "onboarding",
            text: "Codex OAuth is still missing. Run `codex login`, then press Enter again."
          });
          return;
        }

        await openModelSelection("codex", {
          currentModel: defaultCodexModel
        });
        return;
      }

      const selectedModel = selectModelFromInput(value, onboarding.models, onboardingIndex);
      if (!selectedModel) {
        appendLine({
          tone: "warning",
          label: "onboarding",
          text: "Unknown model selection. Pick a listed model."
        });
        return;
      }

      setTelemetry(null);
      setSettings((currentSettings) => ({
        ...currentSettings,
        provider: onboarding.provider,
        model: selectedModel
      }));
      savePatchPilotEnvValues({
        PATCHPILOT_PROVIDER: onboarding.provider,
        PATCHPILOT_MODEL: selectedModel,
        PATCHPILOT_ONBOARDING_COMPLETE: "1",
        ...(onboarding.provider === "ollama" ? { PATCHPILOT_OLLAMA_URL: activeHost?.host.url ?? settings.ollamaUrl } : {})
      });
      appendLine({
        tone: "success",
        label: "onboarding",
        text: `ready: ${onboarding.provider} using ${selectedModel}`
      });
      if (onboarding.provider === "openrouter" && isOpenRouterFreeModel(selectedModel)) {
        appendLine({
          tone: "warning",
          label: "openrouter",
          text: "Free OpenRouter models are rate-limited.",
          detail: "OpenRouter documents 20 requests/minute for :free models, plus daily limits depending on account credits."
        });
      }
      closeOnboarding();
    },
    [activeHost?.host.url, appendLine, closeOnboarding, connectToHost, loadHostSuggestions, onboarding, onboardingIndex, openModelSelection, settings.ollamaUrl]
  );

  const runTask = useCallback(
    async (task: string) => {
      if (!task.trim() || isRunning) {
        return;
      }

      setInput("");
      setTranscriptScrollOffset(0);
      setIsRunning(true);
      appendLine({
        tone: "normal",
        label: "you",
        text: task
      });

      try {
        const runnableSettings = await resolveRunnableSettings(settings, modelOptions, appendLine, setModelOptions);
        if (!runnableSettings) {
          return;
        }

        const taskRunner = new AgentRunner(runnableSettings);
        for await (const event of taskRunner.run(task)) {
          if (event.type === "metrics") {
            if (runnableSettings.provider === "ollama") {
              usedOllamaModelsRef.current.add(`${runnableSettings.ollamaUrl}|${runnableSettings.model}`);
            }
            setTelemetry(event.metrics);
            setSessionTelemetry((currentSession) => addTelemetryToSession(currentSession, event.metrics));
            continue;
          }

          if (event.type === "subagent") {
            setTelemetry(event.metrics);
            setSessionTelemetry((currentSession) => addTelemetryToSession(currentSession, event.metrics));
            setAdvisorNotes((currentNotes) =>
              upsertAdvisorNote(currentNotes, {
                role: event.role,
                message: event.message
              })
            );
          }

          setStatus(eventToStatus(event));
          appendLine(eventToLine(event));
        }
      } catch (error) {
        appendLine({
          tone: "danger",
          label: "error",
          text: error instanceof Error ? error.message : String(error)
        });
      } finally {
        setStatus("idle");
        setIsRunning(false);
      }
    },
    [appendLine, isRunning, modelOptions, settings]
  );

  const handleSlashCommand = useCallback(
    async (rawCommand: string) => {
      const [commandName = "", ...args] = rawCommand.slice(1).trim().split(/\s+/);
      const command = commandName.toLowerCase();

      switch (command) {
        case "":
        case "help":
          appendLine({
            tone: "accent",
            label: "commands",
            text: "Slash commands. Type / plus a few letters to filter.",
            detail: formatCommandDetail()
          });
          return;
        case "build":
        case "plan":
        case "mode": {
          const nextMode = command === "mode" ? args[0]?.toLowerCase() : command;
          if (nextMode !== "plan" && nextMode !== "build") {
            appendLine({
              tone: "accent",
              label: "mode",
              text: `current ${agentMode}. Use /mode plan, /mode build, or press tab.`
            });
            return;
          }

          applyMode(nextMode);
          return;
        }
        case "permissions":
        case "perms":
          appendLine({
            tone: "accent",
            label: "permissions",
            text: `write ${settings.allowWrite ? "on" : "off"} | shell ${settings.allowShell ? "on" : "off"} | subagents ${settings.subagents ? "on" : "off"}`
          });
          return;
        case "provider": {
          const nextProvider = args[0]?.toLowerCase();
          if (nextProvider !== "ollama" && nextProvider !== "gemini" && nextProvider !== "codex" && nextProvider !== "openrouter") {
            appendLine({
              tone: "accent",
              label: "provider",
              text: `current ${settings.provider}. Use /provider ollama, /provider gemini, /provider codex, or /provider openrouter.`
            });
            return;
          }

          const nextModel = defaultModelForProvider(nextProvider, settings.model);
          setTelemetry(null);
          setModelOptions([]);
          setSettings((currentSettings) => ({
            ...currentSettings,
            provider: nextProvider,
            model: nextModel
          }));
          savePatchPilotEnvValues({
            PATCHPILOT_PROVIDER: nextProvider,
            PATCHPILOT_MODEL: nextModel
          });
          appendLine({
            tone: "success",
            label: "provider",
            text: `switched to ${nextProvider} using ${nextModel}`
          });
          return;
        }
        case "onboarding":
          setOnboarding({
            step: "entry"
          });
          setOnboardingIndex(0);
          setOnboardingInput("");
          setOnboardingBusyMessage(null);
          return;
        case "agents":
        case "subagents": {
          const subagentsEnabled = readToggle(args[0], !settings.subagents);
          setSettings((currentSettings) => ({
            ...currentSettings,
            subagents: subagentsEnabled
          }));
          appendLine({
            tone: "success",
            label: "agents",
            text: `planner/reviewer subagents ${subagentsEnabled ? "enabled" : "disabled"}`
          });
          return;
        }
        case "think":
        case "thinking": {
          const nextMode = args[0]?.toLowerCase();
          if (nextMode !== "fixed" && nextMode !== "adaptive") {
            appendLine({
              tone: "accent",
              label: "think",
              text: `current ${settings.thinkingMode}. Use /think fixed or /think adaptive.`
            });
            return;
          }

          setSettings((currentSettings) => ({
            ...currentSettings,
            thinkingMode: nextMode
          }));
          appendLine({
            tone: "success",
            label: "think",
            text: `thinking mode ${nextMode}`
          });
          return;
        }
        case "write":
        case "apply": {
          const writeEnabled = readToggle(args[0], !settings.allowWrite);
          if (writeEnabled) {
            setAgentMode("build");
          }

          setSettings((currentSettings) => ({
            ...currentSettings,
            allowWrite: writeEnabled
          }));
          appendLine({
            tone: "success",
            label: "write",
            text: `workspace writes ${writeEnabled ? "enabled" : "disabled"}`
          });
          return;
        }
        case "shell": {
          const shellEnabled = readToggle(args[0], !settings.allowShell);
          if (shellEnabled) {
            setAgentMode("build");
          }

          setSettings((currentSettings) => ({
            ...currentSettings,
            allowShell: shellEnabled
          }));
          appendLine({
            tone: "success",
            label: "shell",
            text: `shell commands ${shellEnabled ? "enabled" : "disabled"}`
          });
          return;
        }
        case "model": {
          const requestedModel = normalizeModelAlias(args.join(" ").trim());
          if (!requestedModel) {
            const models = await loadKnownOrAvailableModels(settings.provider, settings.ollamaUrl, modelOptions, setModelOptions, appendLine);
            if (!models) {
              return;
            }

            appendLine({
              tone: "accent",
              label: "model",
              text: settings.model,
              detail: models.length > 0 ? formatModelOptions(models, settings.model) : "Use /models to load available models."
            });
            return;
          }

          await switchModel(settings.provider, requestedModel, settings.ollamaUrl, settings.model, appendLine, setModelOptions, setSettings, setTelemetry);
          return;
        }
        case "models": {
          const requestedModel = args.join(" ").trim();
          if (requestedModel) {
            const installedModels = await loadKnownOrAvailableModels(settings.provider, settings.ollamaUrl, modelOptions, setModelOptions, appendLine);
            if (!installedModels) {
              return;
            }

            const nextModel = selectModelFromInput(requestedModel, installedModels);
            if (!nextModel) {
              appendLine({
                tone: "warning",
                label: "models",
                text: "No model selected. Use /models to fetch available models, then choose one from the palette."
              });
              return;
            }

            await switchModel(settings.provider, nextModel, settings.ollamaUrl, settings.model, appendLine, setModelOptions, setSettings, setTelemetry, installedModels);
            return;
          }

          appendLine({
            tone: "muted",
            label: "models",
            text: `loading ${settings.provider} models...`
          });

          try {
            const models = await loadProviderModels(true);
            if (models.length === 0) {
              appendLine({
                tone: "warning",
                label: "models",
                text: `No ${settings.provider} models found.`,
                detail:
                  settings.provider === "ollama"
                    ? "Pull a model on the selected host first."
                    : settings.provider === "gemini"
                      ? "Check GEMINI_API_KEY in PatchPilot config."
                      : "Run codex login first."
              });
              return;
            }

            appendLine({
              tone: "accent",
              label: "models",
              text: `Loaded ${models.length} model${models.length === 1 ? "" : "s"} from ${settings.provider}.`,
              detail: formatModelOptions(models, settings.model)
            });
          } catch (error) {
            appendLine({
              tone: "danger",
              label: "models",
              text: error instanceof Error ? error.message : String(error)
            });
          }
          return;
        }
        case "status":
          appendLine({
            tone: "accent",
            label: "status",
            text:
              settings.provider === "ollama"
                ? `provider ollama | model ${settings.model} | host ${activeHost?.host.deviceName ?? settings.ollamaUrl} | route ${activeHost?.host.url ?? settings.ollamaUrl} | compute ${describeComputeTarget(settings.ollamaUrl).kind} | tools local | agents ${settings.subagents ? "on" : "off"} | write ${settings.allowWrite ? "on" : "off"} | shell ${settings.allowShell ? "on" : "off"} | draft ${draftTokens} tok | last ${formatTokens(telemetry)} | session ${formatSessionTokens(sessionTelemetry)} | cost ${formatCost(sessionTelemetry.estimatedCostUsd)}`
                : `provider ${settings.provider} | model ${settings.model} | host ${settings.provider} oauth | compute cloud | agents ${settings.subagents ? "on" : "off"} | write ${settings.allowWrite ? "on" : "off"} | shell ${settings.allowShell ? "on" : "off"} | draft ${draftTokens} tok | last ${formatTokens(telemetry)} | session ${formatSessionTokens(sessionTelemetry)} | cost ${formatCost(sessionTelemetry.estimatedCostUsd)}`
          });
          return;
        case "connect":
        case "host":
        case "ollama":
          if (settings.provider !== "ollama") {
            appendLine({
              tone: "warning",
              label: "provider",
              text: "Ollama host switching is only available with /provider ollama."
            });
            return;
          }

          if (args.length === 0) {
            appendLine({
              tone: "muted",
              label: "hosts",
              text: "Scanning LAN and Tailscale for Ollama hosts..."
            });
            await loadHostSuggestions(true, true);
            return;
          }

          if (args.join(" ").trim().toLowerCase() === "local") {
            await connectToHost("local");
            return;
          }

          {
            const requestedHost = args.join(" ").trim();
            const hostIndex = Number.parseInt(requestedHost, 10);
            const selectedHost = Number.isInteger(hostIndex) ? hostOptions[hostIndex - 1] : undefined;
            if (selectedHost) {
              await connectToHost(selectedHost);
            } else {
              await connectToHost(requestedHost);
            }
          }
          return;
        case "hosts":
          appendLine({
            tone: "muted",
            label: "hosts",
            text: "Scanning LAN and Tailscale for Ollama hosts..."
          });
          await loadHostSuggestions(true, true);
          return;
        case "doctor": {
          appendLine({
            tone: "muted",
            label: "doctor",
            text: "checking local requirements..."
          });
          const doctorResults = await runDoctor(settings.provider, settings.ollamaUrl, settings.model);
          for (const result of doctorResults) {
            appendLine({
              tone: result.ok ? "success" : "danger",
              label: result.name,
              text: result.details
            });
          }
          return;
        }
        case "clear":
          setLines([]);
          setAdvisorNotes([]);
          setTelemetry(null);
          setSessionTelemetry(emptySessionTelemetry());
          setTranscriptScrollOffset(0);
          setSessionScrollOffset(0);
          return;
        case "exit":
        case "quit":
        case "q":
          void unloadUsedOllamaModels(usedOllamaModelsRef.current).finally(exit);
          return;
        default:
          appendLine({
            tone: "warning",
            label: "unknown",
            text: `/${command} is not a PatchPilot command. Type /help.`
          });
      }
    },
    [
      activeHost?.host.deviceName,
      activeHost?.host.url,
      agentMode,
      appendLine,
      applyMode,
      connectToHost,
      draftTokens,
      exit,
      hostOptions,
      loadHostSuggestions,
      loadProviderModels,
      modelOptions,
      sessionTelemetry,
      settings,
      telemetry
    ]
  );

  const handleSubmit = useCallback(
    async (value: string) => {
      const nextValue = value.trim();
      if (!nextValue || isRunning) {
        return;
      }

      if (onboarding) {
        await handleOnboardingSubmit(nextValue);
        return;
      }

      if (nextValue.startsWith("/")) {
        const selectedItem = paletteItems[paletteIndex];
        const shouldApplySuggestion =
          selectedItem &&
          (selectedItem.execute || selectedItem.command === nextValue || nextValue === "/" || nextValue.endsWith(" "));
        const commandToRun = shouldApplySuggestion ? selectedItem.command : nextValue;

        if (selectedItem && !selectedItem.execute && commandToRun !== nextValue) {
          setInput(commandToRun);
          return;
        }

        setInput("");
        await handleSlashCommand(commandToRun);
        return;
      }

      await runTask(nextValue);
    },
    [handleOnboardingSubmit, handleSlashCommand, isRunning, onboarding, paletteIndex, paletteItems, runTask]
  );

  useEffect(() => {
    if (!props.initialTask || didRunInitialTask.current || onboarding) {
      return;
    }

    didRunInitialTask.current = true;
    void runTask(props.initialTask);
  }, [onboarding, props.initialTask, runTask]);

  useEffect(() => {
    setPaletteIndex(0);
  }, [hostOptions, input, modelOptions, onboarding, settings.model, settings.provider]);

  useEffect(() => {
    if (didOpenDefaultOnboarding.current || props.initialTask || onboarding || process.env.PATCHPILOT_ONBOARDING_COMPLETE === "1") {
      return;
    }

    didOpenDefaultOnboarding.current = true;
    setOnboarding({
      step: "entry"
    });
    setOnboardingIndex(0);
    setOnboardingInput("");
    setOnboardingBusyMessage(null);
  }, [onboarding, props.initialTask]);

  useEffect(() => {
    if (settings.provider !== "ollama") {
      setActiveHost(null);
      return;
    }

    let cancelled = false;
    async function syncActiveHost(): Promise<void> {
      const verifiedHost = await checkOllamaHost(settings.ollamaUrl, {
        timeoutMs: 800
      });
      if (!verifiedHost) {
        if (!cancelled) {
          setActiveHost(null);
        }
        return;
      }

        const details = await readOllamaHostDetails(verifiedHost).catch(() => ({
        host: verifiedHost,
        models: [] as string[],
        runningModels: [],
        fetchedAt: Date.now()
      }));

      if (cancelled) {
        return;
      }

      setActiveHost(details);
      if (details.models.length > 0) {
        setModelOptions((currentModels) => (currentModels.length > 0 && currentModels.join("\n") === details.models.join("\n") ? currentModels : details.models));
      }
    }

    void syncActiveHost();
    return () => {
      cancelled = true;
    };
  }, [settings.ollamaUrl, settings.provider]);

  useEffect(() => {
    if (onboarding || isRunning) {
      return;
    }

    const trimmedInput = input.trim();
    if (settings.provider === "ollama" && (trimmedInput === "/connect" || trimmedInput === "/hosts") && hostOptions.length === 0 && !isLoadingHosts) {
      void loadHostSuggestions(false, false);
    }

    if ((trimmedInput === "/models" || trimmedInput === "/model") && modelOptions.length === 0 && !isLoadingModels) {
      void loadProviderModels(false);
    }
  }, [hostOptions.length, input, isLoadingHosts, isLoadingModels, isRunning, loadHostSuggestions, loadProviderModels, modelOptions.length, onboarding, settings.provider]);

  useInput((inputValue, key) => {
    if (onboarding) {
      if (key.escape || key.leftArrow) {
        goBackOnboarding();
        return;
      }

      const optionCount = getOnboardingOptionCount(onboarding);
      if (optionCount > 0 && key.upArrow) {
        setOnboardingIndex((currentIndex) => (currentIndex - 1 + optionCount) % optionCount);
        return;
      }

      if (optionCount > 0 && key.downArrow) {
        setOnboardingIndex((currentIndex) => (currentIndex + 1) % optionCount);
        return;
      }

      if (optionCount > 0 && key.return) {
        void handleOnboardingSubmit(String(onboardingIndex + 1));
        return;
      }

      if (onboarding.step === "codex-login" && key.return) {
        void handleOnboardingSubmit("");
        return;
      }

      return;
    }

    if (paletteItems.length > 0) {
      if (key.upArrow) {
        setPaletteIndex((currentIndex) => (currentIndex - 1 + paletteItems.length) % paletteItems.length);
        return;
      }

      if (key.downArrow) {
        setPaletteIndex((currentIndex) => (currentIndex + 1) % paletteItems.length);
        return;
      }

      if (key.escape) {
        setInput("");
        return;
      }
    }

    const canUsePanelKeys = input.length === 0 || isRunning;
    if (canUsePanelKeys && key.leftArrow) {
      setActiveScrollPane("session");
      return;
    }

    if (canUsePanelKeys && key.rightArrow) {
      setActiveScrollPane("transcript");
      return;
    }

    if (canUsePanelKeys && (key.pageUp || key.pageDown || key.home || key.end)) {
      const setOffset = activeScrollPane === "session" ? setSessionScrollOffset : setTranscriptScrollOffset;
      if (key.pageUp) {
        setOffset((currentOffset) => currentOffset + scrollStep);
      } else if (key.pageDown) {
        setOffset((currentOffset) => Math.max(0, currentOffset - scrollStep));
      } else if (key.home) {
        setOffset(1_000_000);
      } else {
        setOffset(0);
      }
      return;
    }

    if (!isRunning && key.tab) {
      toggleMode();
      return;
    }

    if (!isRunning && input.length === 0 && inputValue === "q") {
      void unloadUsedOllamaModels(usedOllamaModelsRef.current).finally(exit);
    }
  });

  useEffect(() => {
    const unloadAndExit = (): void => {
      void unloadUsedOllamaModels(usedOllamaModelsRef.current).finally(() => {
        process.exit(0);
      });
    };

    process.once("SIGINT", unloadAndExit);
    process.once("SIGTERM", unloadAndExit);
    return () => {
      process.off("SIGINT", unloadAndExit);
      process.off("SIGTERM", unloadAndExit);
      void unloadUsedOllamaModels(usedOllamaModelsRef.current);
    };
  }, []);

  useEffect(() => {
    let previousSnapshot = readSystemStats().snapshot;
    const timer = setInterval(() => {
      const nextReading = readSystemStats(previousSnapshot);
      previousSnapshot = nextReading.snapshot;
      setSystemStats(nextReading.stats);
    }, 1000);

    return () => {
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let isMounted = true;

    async function updateGpuStats(): Promise<void> {
      const nextGpuStats = await readGpuStats();
      if (isMounted) {
        setGpuStats(nextGpuStats);
      }
    }

    void updateGpuStats();
    const timer = setInterval(() => {
      void updateGpuStats();
    }, 2500);

    return () => {
      isMounted = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <Box flexDirection="column" paddingX={1} height={rootHeight} overflowY="hidden">
      <Header
        model={settings.model}
        provider={settings.provider}
        workspace={settings.workspace}
        status={status}
        allowWrite={settings.allowWrite}
        allowShell={settings.allowShell}
        agentMode={agentMode}
        subagents={settings.subagents}
        thinkingMode={settings.thinkingMode}
        ollamaUrl={settings.ollamaUrl}
        telemetry={telemetry}
        sessionTelemetry={sessionTelemetry}
        draftTokens={draftTokens}
        systemStats={systemStats}
        gpuStats={gpuStats}
        activeHost={activeHost}
      />

      {onboarding ? (
        <OnboardingPanel
          state={onboarding}
          height={panelHeight}
          selectedIndex={onboardingIndex}
          input={onboardingInput}
          busyMessage={onboardingBusyMessage}
          onInputChange={setOnboardingInput}
          onInputSubmit={(value) => void handleOnboardingSubmit(value)}
        />
      ) : (
        <Box flexDirection="row" height={panelHeight + composerReservedHeight + paletteReservedHeight + footerReservedHeight} overflowY="hidden">
          <Sidebar
            workspace={settings.workspace}
            model={settings.model}
            provider={settings.provider}
            ollamaUrl={settings.ollamaUrl}
            agentMode={agentMode}
            allowWrite={settings.allowWrite}
            allowShell={settings.allowShell}
            subagents={settings.subagents}
            telemetry={telemetry}
            sessionTelemetry={sessionTelemetry}
            draftTokens={draftTokens}
            height={panelHeight}
            scrollOffset={sessionScrollOffset}
            advisors={advisorNotes}
            isActive={activeScrollPane === "session"}
            activeHost={activeHost}
          />
          <Box flexDirection="column" flexGrow={1} height={panelHeight + composerReservedHeight + paletteReservedHeight + footerReservedHeight} overflowY="hidden">
            <Transcript
              lines={lines}
              isRunning={isRunning}
              isActive={activeScrollPane === "transcript"}
              height={panelHeight}
              width={transcriptWidth}
              scrollOffset={transcriptScrollOffset}
            />
            <Composer
              input={input}
              isRunning={isRunning}
              status={status}
              draftTokens={draftTokens}
              onChange={setInput}
              onSubmit={(value) => void handleSubmit(value)}
            />
            {paletteItems.length > 0 ? <CommandSuggestions items={paletteItems} selectedIndex={paletteIndex} /> : null}
            <FooterHints activePane={activeScrollPane} />
          </Box>
        </Box>
      )}
    </Box>
  );
}

async function loadAvailableModels(
  provider: ModelProvider,
  ollamaUrl: string,
  setModelOptions: React.Dispatch<React.SetStateAction<string[]>>,
  refresh = false
): Promise<string[]> {
  const cacheKey = `${provider}:${provider === "ollama" ? ollamaUrl : "default"}`;
  const cachedModels = modelCache.get(cacheKey);
  if (!refresh && cachedModels && cachedModels.expiresAt > Date.now()) {
    setModelOptions(cachedModels.models);
    return cachedModels.models;
  }

  const models = await createModelClient({
    provider,
    ollamaUrl
  }).listModels();
  modelCache.set(cacheKey, {
    models,
    expiresAt: Date.now() + modelCacheTtlMs
  });
  setModelOptions(models);
  return models;
}

async function loadKnownOrAvailableModels(
  provider: ModelProvider,
  ollamaUrl: string,
  modelOptions: string[],
  setModelOptions: React.Dispatch<React.SetStateAction<string[]>>,
  appendLine: (line: Omit<LogLine, "id">) => void
): Promise<string[] | null> {
  try {
    return modelOptions.length > 0 ? modelOptions : await loadAvailableModels(provider, ollamaUrl, setModelOptions);
  } catch (error) {
    appendLine({
      tone: "danger",
      label: "models",
      text: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

async function switchModel(
  provider: ModelProvider,
  nextModel: string,
  ollamaUrl: string,
  currentModel: string,
  appendLine: (line: Omit<LogLine, "id">) => void,
  setModelOptions: React.Dispatch<React.SetStateAction<string[]>>,
  setSettings: React.Dispatch<React.SetStateAction<AgentRunnerOptions>>,
  setTelemetry: React.Dispatch<React.SetStateAction<ModelTelemetry | null>>,
  knownModels?: string[]
): Promise<void> {
  const installedModels =
    knownModels ??
    (await loadAvailableModels(provider, ollamaUrl, setModelOptions).catch((error: unknown) => {
      appendLine({
        tone: "danger",
        label: "models",
        text: error instanceof Error ? error.message : String(error)
      });
      return null;
    }));

  if (!installedModels) {
    return;
  }

  if (!installedModels.includes(nextModel)) {
    appendLine({
      tone: "warning",
      label: "model",
      text: `${nextModel} is not available for ${provider}.`,
      detail:
        installedModels.length > 0
          ? `Use /models and pick one of:\n${formatModelOptions(installedModels, currentModel)}`
      : provider === "ollama"
        ? "No models installed on the selected host."
        : provider === "gemini"
          ? "Check GEMINI_API_KEY in PatchPilot config."
          : provider === "openrouter"
            ? "Check OPENROUTER_API_KEY in PatchPilot config."
            : "Run codex login first."
    });
    return;
  }

  setTelemetry(null);
  setSettings((currentSettings) => ({
    ...currentSettings,
    model: nextModel
  }));
  savePatchPilotEnvValues({
    PATCHPILOT_PROVIDER: provider,
    PATCHPILOT_MODEL: nextModel
  });
  appendLine({
    tone: "success",
    label: "model",
    text: `switched to ${nextModel}`
  });
  if (provider === "openrouter" && isOpenRouterFreeModel(nextModel)) {
    appendLine({
      tone: "warning",
      label: "openrouter",
      text: "Free OpenRouter models are rate-limited.",
      detail: "OpenRouter documents 20 requests/minute for :free models, plus daily limits depending on account credits."
    });
  }
}

async function resolveRunnableSettings(
  settings: AgentRunnerOptions,
  modelOptions: string[],
  appendLine: (line: Omit<LogLine, "id">) => void,
  setModelOptions: React.Dispatch<React.SetStateAction<string[]>>
): Promise<AgentRunnerOptions | null> {
  let installedModels: string[];
  try {
    installedModels = modelOptions.includes(settings.model)
      ? modelOptions
      : await loadAvailableModels(settings.provider, settings.ollamaUrl, setModelOptions);
  } catch (error) {
    appendLine({
      tone: "danger",
      label: settings.provider,
      text: error instanceof Error ? error.message : String(error)
    });
    return null;
  }

  if (installedModels.includes(settings.model)) {
    return settings;
  }

  appendLine({
    tone: "warning",
    label: "model",
    text: `${settings.model} is not available for ${settings.provider}.`,
    detail:
      installedModels.length > 0
        ? `Pick an installed model first:\n${formatModelOptions(installedModels, settings.model)}`
        : settings.provider === "ollama"
          ? "No models installed on the selected host."
          : settings.provider === "gemini"
            ? "No Gemini models listed. Check GEMINI_API_KEY in PatchPilot config."
            : settings.provider === "openrouter"
              ? "No OpenRouter models listed. Check OPENROUTER_API_KEY in PatchPilot config."
              : "Codex OAuth is not ready. Run codex login."
  });
  return null;
}

function buildCommandSuggestionItems(options: {
  input: string;
  provider: ModelProvider;
  hostOptions: OllamaHost[];
  modelOptions: string[];
  currentModel: string;
  isLoadingHosts: boolean;
  isLoadingModels: boolean;
}): PaletteSuggestion[] {
  if (!options.input.startsWith("/")) {
    return [];
  }

  const trimmedInput = options.input.trimStart().toLowerCase();
  const items: PaletteSuggestion[] = filterSlashCommands(options.input)
    .slice(0, 6)
    .map((command) => {
      const baseCommand = `/${command.name}`;
      return {
        key: `command-${command.name}`,
        category: command.category,
        label: baseCommand,
        detail: command.description,
        hint: command.usage.includes("<") || command.usage.includes("[") ? "fill" : "run",
        command: baseCommand,
        execute: !command.usage.includes("<") && !command.usage.includes("[")
      };
    });

  if (options.provider === "ollama" && (trimmedInput === "/connect" || trimmedInput.startsWith("/connect ") || trimmedInput.startsWith("/host"))) {
    if (options.isLoadingHosts) {
      items.unshift({
        key: "hosts-loading",
        category: "host",
        label: "Loading Hosts",
        detail: "Scanning LAN and Tailscale peers...",
        command: "/connect",
        execute: false
      });
    } else {
      items.unshift(
        ...options.hostOptions.slice(0, 5).map((host) => ({
          key: `host-${host.url}`,
          category: "host",
          label: host.deviceName,
          detail: `${host.kind}  ${host.url}${host.version ? `  Ollama ${host.version}` : ""}`,
          command: `/connect ${host.url}`,
          execute: true
        }))
      );
    }
  }

  if (trimmedInput === "/models" || trimmedInput.startsWith("/models") || trimmedInput === "/model" || trimmedInput.startsWith("/model")) {
    if (options.isLoadingModels) {
      items.unshift({
        key: "models-loading",
        category: "model",
        label: "Loading Models",
        detail: `Fetching ${options.provider} models...`,
        command: "/models",
        execute: false
      });
    } else {
      items.unshift(
        ...options.modelOptions.slice(0, 8).map((model) => ({
          key: `model-${model}`,
          category: "model",
          label: model,
          detail: `${model === options.currentModel ? "current" : "available"}  ${options.provider}`,
          command: `/model ${model}`,
          execute: true
        }))
      );
    }
  }

  return items.slice(0, 8);
}

function getOnboardingOptionCount(onboarding: OnboardingState): number {
  switch (onboarding.step) {
    case "entry":
      return 5;
    case "host":
      return onboarding.hosts.length + 1;
    case "model":
      return onboarding.models.length;
    default:
      return 0;
  }
}

function readEntrySelection(value: string, selectedIndex: number): "local" | "host" | "gemini" | "openrouter" | "codex" | null {
  const normalizedValue = value.trim().toLowerCase();
  if (!normalizedValue) {
    return ["local", "host", "gemini", "openrouter", "codex"][selectedIndex] as "local" | "host" | "gemini" | "openrouter" | "codex";
  }

  if (normalizedValue === "1" || normalizedValue === "local" || normalizedValue === "this device") {
    return "local";
  }

  if (normalizedValue === "2" || normalizedValue === "host" || normalizedValue === "remote host" || normalizedValue === "remote") {
    return "host";
  }

  if (normalizedValue === "3" || normalizedValue === "gemini" || normalizedValue === "google") {
    return "gemini";
  }

  if (normalizedValue === "4" || normalizedValue === "openrouter" || normalizedValue === "open-router") {
    return "openrouter";
  }

  if (normalizedValue === "5" || normalizedValue === "codex") {
    return "codex";
  }

  return null;
}

function readIndexedSelection(value: string, selectedIndex: number): number | null {
  const normalizedValue = value.trim();
  if (!normalizedValue) {
    return selectedIndex;
  }

  const parsedIndex = Number.parseInt(normalizedValue, 10);
  return Number.isInteger(parsedIndex) ? parsedIndex - 1 : null;
}

function selectModelFromInput(value: string, models: string[], selectedIndex?: number): string | null {
  const normalizedValue = normalizeModelAlias(value.trim());
  if (!normalizedValue && selectedIndex !== undefined) {
    return models[selectedIndex] ?? null;
  }

  if (!normalizedValue) {
    return null;
  }

  const modelIndex = Number.parseInt(normalizedValue, 10);
  if (Number.isInteger(modelIndex)) {
    return models[modelIndex - 1] ?? null;
  }

  return models.includes(normalizedValue) ? normalizedValue : null;
}

function defaultModelForProvider(provider: ModelProvider, currentModel: string): string {
  if (provider === "openrouter") {
    return currentModel.includes("/") ? currentModel : defaultOpenRouterModel;
  }

  if (provider === "gemini") {
    return currentModel.startsWith("gemini-") ? currentModel : defaultGeminiModel;
  }

  if (provider === "codex") {
    return currentModel.includes("codex") || currentModel === "codex-mini-latest" ? currentModel : defaultCodexModel;
  }

  return currentModel.startsWith("gemini-") || currentModel.includes("codex") || currentModel.includes("/") ? defaultOllamaModel : currentModel;
}

async function unloadUsedOllamaModels(usedModels: Set<string>): Promise<void> {
  const entries = [...usedModels];
  usedModels.clear();
  await Promise.allSettled(
    entries.map(async (entry) => {
      const [url, model] = entry.split("|");
      if (!url || !model) {
        return;
      }

      await new OllamaClient(url).unloadModel(model);
    })
  );
}

function upsertAdvisorNote(notes: AdvisorNote[], nextNote: AdvisorNote): AdvisorNote[] {
  const nextNotes = notes.filter((note) => note.role !== nextNote.role);
  return [...nextNotes, nextNote].slice(-2);
}

function eventToLine(event: AgentEvent): Omit<LogLine, "id"> {
  switch (event.type) {
    case "status":
      return {
        tone: "muted",
        label: "thinking",
        text: event.message
      };
    case "assistant":
      return {
        tone: "accent",
        label: "pilot",
        text: event.message
      };
    case "subagent":
      return {
        tone: "accent",
        label: event.role,
        text: "advisor brief updated",
        detail: event.message
      };
    case "tool":
      return {
        tone: event.ok ? "success" : "warning",
        label: event.name,
        text: event.summary
      };
    case "final":
      return {
        tone: "success",
        label: "final",
        text: event.message
      };
    case "error":
      return {
        tone: "danger",
        label: "error",
        text: event.message
      };
    case "metrics":
      return {
        tone: "muted",
        label: "metrics",
        text: formatTokens(event.metrics)
      };
  }
}

function eventToStatus(event: AgentEvent): string {
  if (event.type === "status") {
    return event.message;
  }

  if (event.type === "tool") {
    return `${event.name}: ${event.summary}`;
  }

  if (event.type === "subagent") {
    return `${event.role} subagent`;
  }

  return event.type;
}

function formatHostOptions(hosts: OllamaHost[]): string {
  return hosts
    .map((host, index) => {
      const version = host.version ? `  Ollama ${host.version}` : "";
      return `${index + 1}. ${host.deviceName}  ${host.kind}  ${host.url}${version}`;
    })
    .join("\n");
}

function formatModelOptions(models: string[], currentModel: string): string {
  return models
    .map((model, index) => {
      const currentMarker = model === currentModel ? "  current" : "";
      return `${index + 1}. ${model}${currentMarker}`;
    })
    .join("\n");
}
