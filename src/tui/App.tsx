import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, useApp, useInput, useStdout } from "ink";
import { AgentRunner, type AgentRunnerOptions } from "../core/agent.js";
import { cleanupPatchPilot, readCleanupTarget } from "../core/cleanup.js";
import { defaultCodexModel, hasCodexCliOAuth } from "../core/codex.js";
import { describeComputeTarget } from "../core/compute.js";
import { runDoctor } from "../core/doctor.js";
import { savePatchPilotEnvValues } from "../core/env.js";
import { defaultGeminiModel, readGeminiApiKey } from "../core/gemini.js";
import {
  defaultGeminiWrapperModel,
  geminiWrapperCuratedModels,
  geminiWrapperShortcutModels,
  geminiWrapperRequiresApiKey,
  readGeminiWrapperApiKey,
  readGeminiWrapperBaseUrl,
  readGeminiWrapperCookiesJson,
  readGeminiWrapperMode,
  readGeminiWrapperPythonCommand,
  importGeminiWrapperBrowserCookies,
  saveGeminiWrapperCookieFile
} from "../core/geminiWrapper.js";
import { createModelClient } from "../core/modelClient.js";
import { defaultNvidiaModel, readNvidiaApiKey } from "../core/nvidia.js";
import { defaultOllamaModel, OllamaClient } from "../core/ollama.js";
import { defaultOpenRouterModel, isOpenRouterFreeModel, readOpenRouterApiKey } from "../core/openrouter.js";
import { ensurePatchPilotGitignore, patchPilotInitPrompt } from "../core/projectInit.js";
import { formatReasoningSupport } from "../core/reasoning.js";
import { buildSessionResumeContext, listWorkspaceSessions, loadSessionSummary, SessionStore } from "../core/session.js";
import { addTelemetryToSession, emptySessionTelemetry, estimateTokens } from "../core/tokenAccounting.js";
import type { AgentEvent, AgentTodoItem, AgentToolName, AgentWorkState, ApprovalRequest, ModelDescriptor, ModelProvider, ModelTelemetry, PermissionDecision, SessionTelemetry } from "../core/types.js";
import { getToolSpec, WorkspaceTools } from "../core/workspace.js";
import { ApprovalPanel } from "./components/ApprovalPanel.js";
import { CommandSuggestions, type CommandSuggestionItem } from "./components/CommandSuggestions.js";
import { Composer, FooterHints } from "./components/Composer.js";
import { ExperimentalPanel, experimentalFlagAt, experimentalFlagCount, type ExperimentalFlags } from "./components/ExperimentalPanel.js";
import { Header } from "./components/Header.js";
import { OnboardingPanel, type ApiKeyProvider, type OnboardingState } from "./components/OnboardingPanel.js";
import { Sidebar } from "./components/Sidebar.js";
import { Transcript } from "./components/Transcript.js";
import { filterSlashCommands, formatCommandDetail, formatCommandHelp } from "./commands.js";
import { formatCost, formatSessionTokens, formatTokens, normalizeModelAlias, readToggle } from "./format.js";
import { checkOllamaHost, discoverOllamaHosts, normalizeOllamaUrl, readOllamaHostDetails, startLocalOllamaAppAndWait, type OllamaHost, type OllamaHostDetails } from "./hosts.js";
import { computeComposerLayout } from "./layout.js";
import { initialAgentMode, modeDescription, modePermissionLabel, nextAgentMode, permissionsForMode } from "./modes.js";
import { selectableModels } from "./modelSelection.js";
import { readGpuStats, readSystemStats, type GpuStats, type SystemStats } from "./systemStats.js";
import { maxTranscriptLines, type AdvisorNote, type AgentMode, type LogLine, type LogLineInput } from "./types.js";

export type PatchPilotAppProps = AgentRunnerOptions & {
  initialTask?: string;
};

type PaletteSuggestion = CommandSuggestionItem & {
  command: string;
  execute: boolean;
};

const modelCacheTtlMs = 5 * 60_000;
const modelCache = new Map<string, { models: string[]; descriptors: ModelDescriptor[]; expiresAt: number }>();
const modelDescriptorIndex = new Map<string, ModelDescriptor>();

export function App(props: PatchPilotAppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [input, setInput] = useState(props.initialTask ?? "");
  const didRunInitialTask = useRef(false);
  const didOpenDefaultOnboarding = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const sessionStoreRef = useRef(new SessionStore({ workspace: props.workspace }));
  const approvalResolverRef = useRef<((decision: PermissionDecision) => void) | null>(null);
  const runtimeStateRef = useRef({
    isRunning: false,
    hasPendingApproval: false,
    lastSigintAt: 0
  });
  const grantedPermissionsRef = useRef({
    allowWrite: props.allowWrite,
    allowShell: props.allowShell
  });
  const activeHostSyncInFlightRef = useRef(false);
  const autoLoadKeysRef = useRef(new Set<string>());
  const usedOllamaModelsRef = useRef(new Set<string>());
  const [lines, setLines] = useState<LogLine[]>([]);
  const [advisorNotes, setAdvisorNotes] = useState<AdvisorNote[]>([]);
  const [todos, setTodos] = useState<AgentTodoItem[]>([]);
  const [todoFrame, setTodoFrame] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState("idle");
  const [workState, setWorkState] = useState<AgentWorkState>("idle");
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(null);
  const [telemetry, setTelemetry] = useState<ModelTelemetry | null>(null);
  const [sessionTelemetry, setSessionTelemetry] = useState<SessionTelemetry>(() => emptySessionTelemetry());
  const [resumeContext, setResumeContext] = useState("");
  const [systemStats, setSystemStats] = useState<SystemStats>(() => readSystemStats().stats);
  const [gpuStats, setGpuStats] = useState<GpuStats | null>(null);
  const [agentMode, setAgentMode] = useState<AgentMode>(() => initialAgentMode({ allowWrite: props.allowWrite, allowShell: props.allowShell }));
  const [bypassConfirmation, setBypassConfirmation] = useState(false);
  const [hostOptions, setHostOptions] = useState<OllamaHost[]>([]);
  const [activeHost, setActiveHost] = useState<OllamaHostDetails | null>(null);
  const [isLoadingHosts, setIsLoadingHosts] = useState(false);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  const [experimentalOpen, setExperimentalOpen] = useState(false);
  const [experimentalIndex, setExperimentalIndex] = useState(0);
  const [experimentalFlags, setExperimentalFlags] = useState<ExperimentalFlags>({
    fileAnalysis: readBooleanEnv(process.env.PATCHPILOT_EXPERIMENTAL_FILE_ANALYSIS, false),
    memory: readBooleanEnv(process.env.PATCHPILOT_EXPERIMENTAL_MEMORY, false),
    subagents: props.subagents
  });
  const [onboardingIndex, setOnboardingIndex] = useState(0);
  const [onboardingInput, setOnboardingInput] = useState("");
  const [onboardingBusyMessage, setOnboardingBusyMessage] = useState<string | null>(null);
  const [onboardingNotice, setOnboardingNotice] = useState<{
    tone: "warning" | "danger" | "success";
    text: string;
    detail?: string;
  } | null>(null);
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
    reasoningEffort: props.reasoningEffort,
    subagents: props.subagents
  });
  const draftTokens = estimateTokens(input);
  const terminalRows = stdout.rows ?? 40;
  const terminalColumns = stdout.columns ?? 120;
  const paletteItems =
    !isRunning && !onboarding && !experimentalOpen
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
  const headerReservedHeight = 5;
  const transcriptWidth = Math.max(42, terminalColumns - 38);
  const paletteReservedHeight = !onboarding && paletteItems.length > 0 ? Math.min(8, paletteItems.length) + 7 : 0;
  const composerReservedHeight = onboarding || experimentalOpen ? 0 : computeComposerLayout({ input, width: transcriptWidth }).height;
  const footerReservedHeight = onboarding || experimentalOpen ? 0 : 1;
  const approvalReservedHeight = !onboarding && !experimentalOpen && (pendingApproval || bypassConfirmation) ? 7 : 0;
  const bodyHeight = Math.max(8, rootHeight - headerReservedHeight);
  const transcriptHeight = Math.max(4, bodyHeight - composerReservedHeight - paletteReservedHeight - footerReservedHeight - approvalReservedHeight);
  const panelHeight = onboarding || experimentalOpen ? bodyHeight : transcriptHeight;
  const scrollStep = Math.max(4, Math.floor(transcriptHeight * 0.8));
  const appendLine = useCallback((line: LogLineInput) => {
    setLines((currentLines) =>
      [
        ...currentLines,
        {
          ...line,
          kind: line.kind ?? defaultLogKind(line),
          id: Date.now() + Math.random()
        }
      ].slice(-maxTranscriptLines)
    );
  }, []);

  useEffect(() => {
    if (!isRunning || todos.every((todo) => todo.status !== "in_progress")) {
      setTodoFrame(0);
      return;
    }

    const timer = setInterval(() => {
      setTodoFrame((currentFrame) => (currentFrame + 1) % 4);
    }, 180);

    return () => {
      clearInterval(timer);
    };
  }, [isRunning, todos]);

  const resolveApproval = useCallback(
    (decision: PermissionDecision) => {
      if (!pendingApproval || !approvalResolverRef.current) {
        return;
      }

      approvalResolverRef.current(decision);
      approvalResolverRef.current = null;
      const nextWorkState = decision === "deny" ? "error" : workStateForApprovalTool(pendingApproval.tool);
      setInput("");
      setStatus(decision === "deny" ? `${pendingApproval.tool} denied` : `${pendingApproval.tool} approved; running`);
      setWorkState(nextWorkState);
      appendLine({
        kind: "approval",
        tone: decision === "deny" ? "warning" : "success",
        label: "approval",
        text: `${pendingApproval.tool} ${decision.replace("_", " ")}`,
        detail: pendingApproval.preview,
        workState: nextWorkState,
        tool: pendingApproval.tool
      });
      setPendingApproval(null);
    },
    [appendLine, pendingApproval]
  );

  const applyMode = useCallback(
    (nextMode: AgentMode, announce = true) => {
      const permissions = permissionsForMode(nextMode);
      setAgentMode(nextMode);
      setBypassConfirmation(false);
      grantedPermissionsRef.current = permissions;
      setSettings((currentSettings) => ({
        ...currentSettings,
        allowWrite: permissions.allowWrite,
        allowShell: permissions.allowShell
      }));

      if (announce) {
        appendLine({
          tone: nextMode === "bypass" ? "warning" : "success",
          label: "mode",
          text: modeDescription(nextMode),
          detail:
            nextMode === "plan"
              ? "Read/search/status tools can still run. Writes, tests, scripts, and shell are denied."
              : nextMode === "build"
                ? "Risky tools can run only after allow once/session approval."
                : "Use only in a trusted workspace. Path guards and destructive shell guards still apply."
        });
      }
    },
    [appendLine]
  );

  const requestBypassMode = useCallback(() => {
    if (bypassConfirmation) {
      return;
    }

    setBypassConfirmation(true);
    setStatus("bypass confirmation needed");
    setWorkState("waiting_approval");
  }, [bypassConfirmation]);

  const confirmBypassMode = useCallback(() => {
    setInput("");
    applyMode("bypass");
  }, [applyMode]);

  const setExplicitPermission = useCallback(
    (permission: "write" | "shell", enabled: boolean) => {
      const nextPermissions = {
        allowWrite: permission === "write" ? enabled : settings.allowWrite,
        allowShell: permission === "shell" ? enabled : settings.allowShell
      };
      grantedPermissionsRef.current = nextPermissions;
      setBypassConfirmation(false);
      setAgentMode(nextPermissions.allowWrite && nextPermissions.allowShell ? "bypass" : nextPermissions.allowWrite || nextPermissions.allowShell ? "build" : "plan");
      setSettings((currentSettings) => ({
        ...currentSettings,
        ...nextPermissions
      }));
    },
    [settings.allowShell, settings.allowWrite]
  );

  const cancelBypassMode = useCallback(() => {
    setInput("");
    setBypassConfirmation(false);
    setStatus("idle");
    setWorkState("idle");
    applyMode("build", false);
    appendLine({
      kind: "approval",
      tone: "warning",
      label: "bypass",
      text: "Bypass cancelled. Build mode still uses approvals."
    });
  }, [appendLine, applyMode]);

  const toggleMode = useCallback(() => {
    const mode = nextAgentMode(agentMode);
    if (mode === "bypass") {
      requestBypassMode();
      return;
    }

    applyMode(mode);
  }, [agentMode, applyMode, requestBypassMode]);

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
        descriptors: details.models.map((model) => ({ id: model, displayName: model })),
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
      setOnboardingInput("");
      setOnboardingNotice(null);
      setOnboardingBusyMessage(null);
      const nextModel = defaultModelForProvider(provider, options.currentModel ?? settings.model);
      setSettings((currentSettings) => ({
        ...currentSettings,
        provider,
        model: nextModel
      }));

      setOnboardingBusyMessage(`Loading ${provider} models...`);
      try {
        const models = await loadAvailableModels(provider, options.ollamaUrl ?? settings.ollamaUrl, setModelOptions, true);
        if (models.length === 0) {
          setOnboardingNotice({
            tone: "warning",
            text:
              provider === "ollama"
                ? "No Ollama models found on that host."
                : provider === "gemini"
                  ? "No Gemini models listed. Check the API key."
                  : provider === "gemini-wrapper"
                    ? "No Gemini-Wrapper models listed. Check the bridge install and cookie setup."
                  : provider === "openrouter"
                    ? "No OpenRouter models listed. Check the API key."
                    : provider === "nvidia"
                      ? "No NVIDIA models listed. Check the API key."
                      : "No Codex OAuth models listed.",
            detail: "Use the back key to choose another provider or retry after fixing the provider setup."
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
        setOnboardingNotice({
          tone: "danger",
          text: error instanceof Error ? error.message : String(error),
          detail: "Fix the provider setup, then press Enter or go back and retry."
        });
      } finally {
        setOnboardingBusyMessage(null);
      }
    },
    [settings.model, settings.ollamaUrl]
  );

  const closeOnboarding = useCallback(() => {
    setOnboarding(null);
    setOnboardingIndex(0);
    setOnboardingInput("");
    setOnboardingBusyMessage(null);
    setOnboardingNotice(null);
  }, []);

  const goBackOnboarding = useCallback(() => {
    if (!onboarding) {
      return;
    }

    setOnboardingBusyMessage(null);
    setOnboardingInput("");
    setOnboardingNotice(null);
    setOnboardingIndex(0);

    switch (onboarding.step) {
      case "welcome":
        setOnboarding(null);
        return;
      case "entry":
        setOnboarding(null);
        return;
      case "host":
      case "api-key-choice":
      case "gemini-key":
      case "gemini-wrapper-url":
      case "gemini-wrapper-psid":
      case "gemini-wrapper-psidts":
      case "gemini-wrapper-model-mode":
      case "gemini-wrapper-key":
      case "openrouter-key":
      case "nvidia-key":
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
          openApiKeyChoice("gemini", setOnboarding, setOnboardingIndex);
          return;
        }

        if (onboarding.provider === "gemini-wrapper") {
          setOnboarding({
            step: "gemini-wrapper-model-mode"
          });
          return;
        }

        if (onboarding.provider === "nvidia") {
          openApiKeyChoice("nvidia", setOnboarding, setOnboardingIndex);
          return;
        }

        if (onboarding.provider === "openrouter") {
          openApiKeyChoice("openrouter", setOnboarding, setOnboardingIndex);
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

      if (onboardingBusyMessage) {
        return;
      }

      setOnboardingNotice(null);

      if (onboarding.step === "welcome") {
        setOnboarding({
          step: "entry"
        });
        setOnboardingIndex(0);
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
            setOnboardingBusyMessage(null);
            setOnboardingNotice({
              tone: "warning",
              text: "Local Ollama is not reachable.",
              detail: "Start Ollama.app or run `ollama serve`, then press Enter to retry."
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

        if (selection === "gemini" || selection === "gemini-wrapper" || selection === "openrouter" || selection === "nvidia") {
          openApiKeyChoice(selection, setOnboarding, setOnboardingIndex);
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
          setOnboardingNotice({
            tone: "warning",
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
          setOnboardingNotice({
            tone: "warning",
            text: `No Ollama server answered at ${selectedHost.url}.`,
            detail: "Check firewall, MagicDNS/IP, and whether Ollama is listening on that machine."
          });
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
          setOnboardingNotice({
            tone: "warning",
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
          setOnboardingNotice({
            tone: "warning",
            text: `No Ollama server answered at ${hostValue}.`,
            detail: "Check the IP, MagicDNS name, firewall rules, and whether Ollama is running."
          });
          return;
        }

        await openModelSelection("ollama", {
          deviceName: details.host.deviceName,
          ollamaUrl: details.host.url
        });
        return;
      }

      if (onboarding.step === "api-key-choice") {
        const choice = readIndexedSelection(value, onboardingIndex);
        if (choice === null) {
          return;
        }

        if (onboarding.provider === "gemini-wrapper") {
          if (choice === 0 && onboarding.hasExistingKey) {
            setOnboarding({
              step: "gemini-wrapper-model-mode"
            });
            setOnboardingInput("");
            setOnboardingIndex(0);
            return;
          }

          const importChoice = onboarding.hasExistingKey ? 1 : 0;
          if (choice === importChoice) {
            setOnboardingBusyMessage("Importing Gemini browser cookies...");
            try {
              const result = await importGeminiWrapperBrowserCookies();
              process.env.PATCHPILOT_GEMINI_WRAPPER_MODE = "python";
              process.env.PATCHPILOT_GEMINI_WRAPPER_COOKIES_JSON = result.cookiesPath;
              savePatchPilotEnvValues({
                PATCHPILOT_PROVIDER: "gemini-wrapper",
                PATCHPILOT_MODEL: defaultGeminiWrapperModel,
                PATCHPILOT_GEMINI_WRAPPER_MODE: "python",
                PATCHPILOT_GEMINI_WRAPPER_COOKIES_JSON: result.cookiesPath
              });
              setOnboardingNotice({
                tone: "success",
                text: `Imported ${result.cookieCount} Gemini browser cookies from ${result.source}.`,
                detail: `${result.cookiesPath} was written with owner-only permissions. Secret values were not printed.`
              });
              setOnboarding({
                step: "gemini-wrapper-model-mode"
              });
              setOnboardingInput("");
              setOnboardingIndex(0);
            } catch (error) {
              setOnboardingNotice({
                tone: "warning",
                text: "Gemini browser cookie import failed.",
                detail: error instanceof Error ? error.message : String(error)
              });
            } finally {
              setOnboardingBusyMessage(null);
            }
            return;
          }

          setOnboarding({
            step: "gemini-wrapper-psid"
          });
          setOnboardingInput("");
          setOnboardingIndex(0);
          return;
        }

        if (choice === 0 && onboarding.hasExistingKey) {
          await openModelSelection(onboarding.provider, {
            currentModel: defaultModelForProvider(onboarding.provider, settings.model)
          });
          return;
        }

        setOnboarding({
          step: `${onboarding.provider}-key` as "gemini-key" | "openrouter-key" | "nvidia-key"
        });
        setOnboardingInput("");
        setOnboardingIndex(0);
        return;
      }

      if (onboarding.step === "gemini-key") {
        const apiKey = value.trim();
        if (!apiKey) {
          setOnboardingNotice({
            tone: "warning",
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
        setOnboardingNotice({
          tone: "success",
          text: "Gemini API key saved to PatchPilot config."
        });
        await openModelSelection("gemini", {
          currentModel: defaultGeminiModel
        });
        return;
      }

      if (onboarding.step === "gemini-wrapper-psid") {
        const secure1psid = value.trim();
        if (!secure1psid) {
          setOnboardingNotice({
            tone: "warning",
            text: "__Secure-1PSID cannot be empty.",
            detail: "Paste the cookie value manually. PatchPilot will not scan browser profiles."
          });
          return;
        }

        setOnboarding({
          step: "gemini-wrapper-psidts",
          secure1psid
        });
        setOnboardingInput("");
        setOnboardingIndex(0);
        return;
      }

      if (onboarding.step === "gemini-wrapper-psidts") {
        const secure1psidts = value.trim();
        const cookiesPath = saveGeminiWrapperCookieFile({
          secure1psid: onboarding.secure1psid,
          secure1psidts
        });

        process.env.PATCHPILOT_GEMINI_WRAPPER_MODE = "python";
        process.env.PATCHPILOT_GEMINI_WRAPPER_COOKIES_JSON = cookiesPath;
        savePatchPilotEnvValues({
          PATCHPILOT_PROVIDER: "gemini-wrapper",
          PATCHPILOT_MODEL: defaultGeminiWrapperModel,
          PATCHPILOT_GEMINI_WRAPPER_MODE: "python",
          PATCHPILOT_GEMINI_WRAPPER_COOKIES_JSON: cookiesPath
        });
        setOnboardingNotice({
          tone: "success",
          text: "Gemini-API bridge cookies saved to PatchPilot config.",
          detail: `${cookiesPath} was written with owner-only permissions. PatchPilot will run gemini_webapi through python3.`
        });
        setOnboarding({
          step: "gemini-wrapper-model-mode"
        });
        setOnboardingInput("");
        setOnboardingIndex(0);
        return;
      }

      if (onboarding.step === "gemini-wrapper-model-mode") {
        const choice = readIndexedSelection(value, onboardingIndex);
        if (choice === null) {
          return;
        }

        const curatedModel = geminiWrapperShortcutModels[choice];
        if (curatedModel) {
          setTelemetry(null);
          const shortcutDescriptors = geminiWrapperShortcutModels.map((model) => ({ id: model, displayName: model }));
          rememberModelDescriptors(shortcutDescriptors);
          setModelOptions([...geminiWrapperShortcutModels]);
          setSettings((currentSettings) => ({
            ...currentSettings,
            provider: "gemini-wrapper",
            model: curatedModel
          }));
          savePatchPilotEnvValues({
            PATCHPILOT_PROVIDER: "gemini-wrapper",
            PATCHPILOT_MODEL: curatedModel,
            PATCHPILOT_GEMINI_WRAPPER_MODE: "python",
            PATCHPILOT_ONBOARDING_COMPLETE: "1"
          });
          process.env.PATCHPILOT_ONBOARDING_COMPLETE = "1";
          appendLine({
            tone: "success",
            label: "onboarding",
            text: `ready: gemini-wrapper using ${curatedModel}`
          });
          closeOnboarding();
          return;
        }

        await openModelSelection("gemini-wrapper", {
          currentModel: settings.model
        });
        return;
      }

      if (onboarding.step === "gemini-wrapper-url") {
        const baseUrl = value.trim().replace(/\/$/, "");
        if (!baseUrl) {
          setOnboardingNotice({
            tone: "warning",
            text: "Gemini-Wrapper URL cannot be empty."
          });
          return;
        }

        try {
          new URL(baseUrl);
        } catch {
          setOnboardingNotice({
            tone: "warning",
            text: "Gemini-Wrapper URL must be a valid URL.",
            detail: "Example: http://localhost:8787/v1"
          });
          return;
        }

        process.env.PATCHPILOT_GEMINI_WRAPPER_BASE_URL = baseUrl;
        process.env.PATCHPILOT_GEMINI_WRAPPER_MODE = "http";
        savePatchPilotEnvValues({
          PATCHPILOT_PROVIDER: "gemini-wrapper",
          PATCHPILOT_MODEL: defaultGeminiWrapperModel,
          PATCHPILOT_GEMINI_WRAPPER_BASE_URL: baseUrl,
          PATCHPILOT_GEMINI_WRAPPER_MODE: "http"
        });
        setOnboardingNotice({
          tone: "success",
          text: "Gemini-Wrapper URL saved to PatchPilot config.",
          detail: "PatchPilot uses only this explicit URL and never reads browser cookies."
        });
        if (geminiWrapperRequiresApiKey(baseUrl) && !readGeminiWrapperApiKey()) {
          setOnboarding({
            step: "gemini-wrapper-key",
            baseUrl
          });
          setOnboardingInput("");
          setOnboardingIndex(0);
          return;
        }

        await openModelSelection("gemini-wrapper", {
          currentModel: defaultGeminiWrapperModel
        });
        return;
      }

      if (onboarding.step === "gemini-wrapper-key") {
        const apiKey = value.trim();
        if (geminiWrapperRequiresApiKey(onboarding.baseUrl) && !apiKey) {
          setOnboardingNotice({
            tone: "warning",
            text: "Gemini-Wrapper API key cannot be empty for remote wrapper URLs."
          });
          return;
        }

        process.env.PATCHPILOT_GEMINI_WRAPPER_API_KEY = apiKey;
        savePatchPilotEnvValues({
          PATCHPILOT_PROVIDER: "gemini-wrapper",
          PATCHPILOT_MODEL: defaultGeminiWrapperModel,
          PATCHPILOT_GEMINI_WRAPPER_BASE_URL: onboarding.baseUrl,
          PATCHPILOT_GEMINI_WRAPPER_MODE: "http",
          ...(apiKey ? { PATCHPILOT_GEMINI_WRAPPER_API_KEY: apiKey } : {})
        });
        setOnboardingNotice({
          tone: "success",
          text: apiKey ? "Gemini-Wrapper API key saved to PatchPilot config." : "Gemini-Wrapper local URL saved without an API key."
        });
        await openModelSelection("gemini-wrapper", {
          currentModel: defaultGeminiWrapperModel
        });
        return;
      }

      if (onboarding.step === "openrouter-key") {
        const apiKey = value.trim();
        if (!apiKey) {
          setOnboardingNotice({
            tone: "warning",
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
        setOnboardingNotice({
          tone: "success",
          text: "OpenRouter API key saved to PatchPilot config."
        });
        await openModelSelection("openrouter", {
          currentModel: defaultOpenRouterModel
        });
        return;
      }

      if (onboarding.step === "nvidia-key") {
        const apiKey = value.trim();
        if (!apiKey) {
          setOnboardingNotice({
            tone: "warning",
            text: "NVIDIA API key cannot be empty."
          });
          return;
        }

        process.env.NVIDIA_API_KEY = apiKey;
        savePatchPilotEnvValues({
          PATCHPILOT_PROVIDER: "nvidia",
          PATCHPILOT_MODEL: defaultNvidiaModel,
          NVIDIA_API_KEY: apiKey
        });
        setOnboardingNotice({
          tone: "success",
          text: "NVIDIA API key saved to PatchPilot config."
        });
        await openModelSelection("nvidia", {
          currentModel: defaultNvidiaModel
        });
        return;
      }

      if (onboarding.step === "codex-login") {
        if (!hasCodexCliOAuth()) {
          setOnboardingNotice({
            tone: "warning",
            text: "Codex OAuth is still missing.",
            detail: "Run `codex login` in another terminal, then press Enter to retry."
          });
          return;
        }

        await openModelSelection("codex", {
          currentModel: defaultCodexModel
        });
        return;
      }

      const visibleModels = selectableModels(onboardingInput, onboarding.models, formatModelLabel);
      const selectedModel = visibleModels[onboardingIndex] ?? selectModelFromInput(value, visibleModels, onboardingIndex, {
        allowManual: onboarding.provider !== "ollama" && onboarding.provider !== "gemini-wrapper"
      });
      if (!selectedModel) {
        setOnboardingNotice({
          tone: "warning",
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
      process.env.PATCHPILOT_ONBOARDING_COMPLETE = "1";
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
    [activeHost?.host.url, appendLine, closeOnboarding, connectToHost, loadHostSuggestions, onboarding, onboardingBusyMessage, onboardingIndex, openModelSelection, settings.ollamaUrl]
  );

  const runTask = useCallback(
    async (task: string, overrides: { mode?: AgentMode } = {}) => {
      if (!task.trim() || isRunning) {
        return;
      }

      setInput("");
      setTranscriptScrollOffset(0);
      setTodos([]);
      setIsRunning(true);
      appendLine({
        kind: "user",
        tone: "normal",
        label: "you",
        text: task
      });

      try {
        const runnableSettings = await resolveRunnableSettings(settings, modelOptions, appendLine, setModelOptions);
        if (!runnableSettings) {
          return;
        }

        const abortController = new AbortController();
        abortControllerRef.current = abortController;
        const effectiveMode = overrides.mode ?? agentMode;
        const taskRunner = new AgentRunner({
          ...runnableSettings,
          allowExternalFileAnalysis: experimentalFlags.fileAnalysis,
          memoryEnabled: experimentalFlags.memory,
          mode: effectiveMode,
          signal: abortController.signal,
          sessionStore: sessionStoreRef.current,
          resumeContext,
          approvalHandler: (request) =>
            new Promise<PermissionDecision>((resolve) => {
              if (effectiveMode === "plan") {
                appendLine({
                  kind: "approval",
                  tone: "warning",
                  label: "approval",
                  text: `${request.tool} blocked in plan mode`,
                  detail: "Switch to /mode build before approving write, script, test, or shell tools.",
                  workState: "waiting_approval",
                  tool: request.tool,
                  preview: request.preview
                });
                resolve("deny");
                return;
              }

              if (effectiveMode === "bypass" && ((request.permission === "write" && runnableSettings.allowWrite) || (request.permission === "shell" && runnableSettings.allowShell))) {
                resolve("allow_session");
                return;
              }

              setPendingApproval(request);
              setWorkState("waiting_approval");
              setStatus(`approval needed for ${request.tool}`);
              setTranscriptScrollOffset(0);
              appendLine({
                kind: "approval",
                tone: "warning",
                label: "approval",
                text: `${request.tool} needs ${request.permission} approval`,
                detail: `${request.preview}  Press y once, a session, or n deny.`,
                workState: "waiting_approval",
                tool: request.tool,
                preview: request.preview
              });
              approvalResolverRef.current = resolve;
            })
        });
        for await (const event of taskRunner.run(task)) {
          setWorkState(event.workState);
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

          if (event.type === "todo") {
            setTodos(event.items);
            setStatus(event.summary);
            continue;
          }

          setStatus(eventToStatus(event));
          appendLine(eventToLine(event));
        }
      } catch (error) {
        if (abortControllerRef.current?.signal.aborted) {
          appendLine({
            kind: "status",
            tone: "warning",
            label: "stop",
            text: "Stopped by user.",
            workState: "done"
          });
          return;
        }

        appendLine({
          kind: "error",
          tone: "danger",
          label: "error",
          text: error instanceof Error ? error.message : String(error),
          workState: "error"
        });
      } finally {
        abortControllerRef.current = null;
        setIsRunning(false);
      }
    },
    [agentMode, appendLine, experimentalFlags, isRunning, modelOptions, resumeContext, settings]
  );

  const handleSlashCommand = useCallback(
    async (rawCommand: string) => {
      const [commandName = "", ...args] = rawCommand.slice(1).trim().split(/\s+/);
      const command = commandName.toLowerCase();

      switch (command) {
        case "":
        case "help":
          {
            const helpTopic = args.join(" ").trim();
            const detail = helpTopic ? formatCommandHelp(helpTopic) : formatCommandDetail();
            appendLine({
              tone: detail ? "accent" : "warning",
              label: "commands",
              text: helpTopic ? (detail ? `Help for /${helpTopic.replace(/^\//, "")}` : `No help topic for /${helpTopic.replace(/^\//, "")}.`) : "Slash commands. Type / plus a few letters to filter.",
              detail: detail ?? "Use /help to list commands."
            });
          }
          return;
        case "build":
        case "plan":
        case "bypass":
        case "mode": {
          const nextMode = command === "mode" ? args[0]?.toLowerCase() : command;
          if (nextMode !== "plan" && nextMode !== "build" && nextMode !== "bypass") {
            appendLine({
              tone: "accent",
              label: "mode",
              text: `current ${agentMode}. Use /mode plan, /mode build, /mode bypass, or press tab.`
            });
            return;
          }

          if (nextMode === "bypass" && agentMode !== "bypass") {
            requestBypassMode();
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
            text: `mode ${agentMode} | write ${modePermissionLabel(agentMode, "write")} | shell ${modePermissionLabel(agentMode, "shell")} | subagents ${settings.subagents ? "on" : "off"}`,
            detail: modeDescription(agentMode)
          });
          return;
        case "provider": {
          const nextProvider = args[0]?.toLowerCase();
          if (nextProvider !== "ollama" && nextProvider !== "gemini" && nextProvider !== "gemini-wrapper" && nextProvider !== "codex" && nextProvider !== "openrouter" && nextProvider !== "nvidia") {
            appendLine({
              tone: "accent",
              label: "provider",
              text: `current ${settings.provider}. Use /provider ollama, gemini, gemini-wrapper, openrouter, nvidia, or codex.`
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
          if (needsApiKey(nextProvider) && !hasApiKey(nextProvider)) {
            openApiKeyChoice(nextProvider, setOnboarding, setOnboardingIndex);
          }
          appendLine({
            tone: needsApiKey(nextProvider) && !hasApiKey(nextProvider) ? "warning" : "success",
            label: "provider",
            text:
              needsApiKey(nextProvider) && !hasApiKey(nextProvider)
                ? `${nextProvider} needs setup. Setup opened.`
                : `switched to ${nextProvider} using ${nextModel}`
          });
          return;
        }
        case "onboarding":
          setOnboarding({
            step: "welcome"
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
          setExperimentalFlags((currentFlags) => ({
            ...currentFlags,
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
        case "reasoning": {
          const nextEffort = args[0]?.toLowerCase();
          if (!isReasoningEffort(nextEffort)) {
            appendLine({
              tone: "accent",
              label: "reasoning",
              text: `current ${settings.reasoningEffort}. Use /reasoning none, low, medium, high, xhigh, or adaptive.`
            });
            return;
          }

          setSettings((currentSettings) => ({
            ...currentSettings,
            reasoningEffort: nextEffort
          }));
          savePatchPilotEnvValues({
            PATCHPILOT_REASONING_EFFORT: nextEffort
          });
          appendLine({
            tone: "success",
            label: "reasoning",
            text: formatReasoningSupport(settings.provider, settings.model, nextEffort === "adaptive" ? undefined : nextEffort)
          });
          return;
        }
        case "write":
        case "apply": {
          const writeEnabled = readToggle(args[0], !settings.allowWrite);
          setExplicitPermission("write", writeEnabled);
          appendLine({
            tone: "success",
            label: "write",
            text: writeEnabled ? "workspace writes are allowed; shell remains separately controlled" : "workspace writes disabled"
          });
          return;
        }
        case "shell": {
          const shellEnabled = readToggle(args[0], !settings.allowShell);
          setExplicitPermission("shell", shellEnabled);
          appendLine({
            tone: "success",
            label: "shell",
            text: shellEnabled ? "shell commands are allowed; writes remain separately controlled" : "shell commands disabled"
          });
          return;
        }
        case "model": {
          const requestedModel = normalizeModelAlias(args.join(" ").trim());
          if (!requestedModel) {
            const models = await loadKnownOrAvailableModels(settings.provider, settings.ollamaUrl, modelOptions, setModelOptions, appendLine, {
              refresh: settings.provider === "gemini-wrapper"
            });
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

          {
            const models = await loadKnownOrAvailableModels(settings.provider, settings.ollamaUrl, modelOptions, setModelOptions, appendLine, {
              refresh: settings.provider === "gemini-wrapper"
            });
            if (!models) {
              return;
            }
            const nextModel = selectModelFromInput(requestedModel, models, undefined, {
              allowManual: settings.provider !== "ollama"
            });
            if (!nextModel) {
              appendLine({
                tone: "warning",
                label: "model",
                text: `No unique model match for "${requestedModel}".`,
                detail: formatModelOptions(selectableModels(requestedModel, models, formatModelLabel).slice(0, 12), settings.model)
              });
              return;
            }
            await switchModel(settings.provider, nextModel, settings.ollamaUrl, settings.model, appendLine, setModelOptions, setSettings, setTelemetry, models);
          }
          return;
        }
        case "models": {
          const requestedModel = args.join(" ").trim();
          if (requestedModel) {
            const installedModels = await loadKnownOrAvailableModels(settings.provider, settings.ollamaUrl, modelOptions, setModelOptions, appendLine, {
              refresh: settings.provider === "gemini-wrapper"
            });
            if (!installedModels) {
              return;
            }

            const nextModel = selectModelFromInput(requestedModel, installedModels, undefined, {
              allowManual: settings.provider !== "ollama"
            });
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
                      : settings.provider === "gemini-wrapper"
                        ? "Check gemini_webapi install and PATCHPILOT_GEMINI_WRAPPER_COOKIES_JSON in PatchPilot config."
                        : settings.provider === "openrouter"
                          ? "Check OPENROUTER_API_KEY in PatchPilot config."
                          : settings.provider === "nvidia"
                            ? "Check NVIDIA_API_KEY in PatchPilot config."
                            : "Run codex login first."
              });
              return;
            }

            setInput("/models ");
            setPaletteIndex(0);
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
                ? `provider ollama | model ${settings.model} | host ${activeHost?.host.deviceName ?? settings.ollamaUrl} | route ${activeHost?.host.url ?? settings.ollamaUrl} | compute ${describeComputeTarget(settings.ollamaUrl).kind} | tools local | agents ${settings.subagents ? "on" : "off"} | mode ${agentMode} | write ${modePermissionLabel(agentMode, "write")} | shell ${modePermissionLabel(agentMode, "shell")} | draft ${draftTokens} tok | last ${formatTokens(telemetry)} | session ${formatSessionTokens(sessionTelemetry)} | cost ${formatCost(sessionTelemetry.estimatedCostUsd)}`
              : `provider ${settings.provider} | model ${settings.model} | host ${settings.provider} api | compute cloud | agents ${settings.subagents ? "on" : "off"} | think ${settings.thinkingMode} | reasoning ${formatReasoningSupport(settings.provider, settings.model, settings.reasoningEffort === "adaptive" ? undefined : settings.reasoningEffort)} | mode ${agentMode} | write ${modePermissionLabel(agentMode, "write")} | shell ${modePermissionLabel(agentMode, "shell")} | draft ${draftTokens} tok | last ${formatTokens(telemetry)} | session ${formatSessionTokens(sessionTelemetry)} | cost ${formatCost(sessionTelemetry.estimatedCostUsd)}`
          });
          return;
        case "sessions": {
          const sessions = await listWorkspaceSessions(settings.workspace);
          appendLine({
            kind: "status",
            tone: sessions.length > 0 ? "accent" : "muted",
            label: "sessions",
            text: sessions.length > 0 ? `Found ${sessions.length} workspace session${sessions.length === 1 ? "" : "s"}.` : "No workspace sessions yet.",
            detail: sessions
              .slice(0, 8)
              .map((session, index) => `${index + 1}. ${session.sessionId}  ${session.updatedAt}  ${session.lastTask ?? "no task"}`)
              .join("\n")
          });
          return;
        }
        case "resume": {
          const sessionId = args[0] ?? "";
          const sessions = await listWorkspaceSessions(settings.workspace);
          const selectedSession = sessionId ? await loadSessionSummary(settings.workspace, sessionId) : sessions[0] ?? null;
          if (selectedSession) {
            sessionStoreRef.current = new SessionStore({
              workspace: settings.workspace,
              sessionId: selectedSession.sessionId
            });
            await sessionStoreRef.current.append({
              type: "session.resumed",
              sessionId: selectedSession.sessionId,
              workspace: settings.workspace,
              resumedAt: new Date().toISOString()
            });
            setResumeContext(await buildSessionResumeContext(settings.workspace, selectedSession.sessionId));
            setSessionTelemetry(emptySessionTelemetry());
            setTelemetry(null);
          }
          appendLine({
            kind: "status",
            tone: selectedSession ? "accent" : "warning",
            label: "resume",
            text: selectedSession ? `Loaded session ${selectedSession.sessionId} and will inject its summary into the next run.` : "No session available to resume.",
            detail: selectedSession
              ? `workspace ${selectedSession.workspace}\nupdated ${selectedSession.updatedAt}\nmodel ${selectedSession.provider ?? "-"} ${selectedSession.model ?? "-"}\nlast task ${selectedSession.lastTask ?? "-"}`
              : "Run /sessions after at least one PatchPilot run."
          });
          return;
        }
        case "diff": {
          const result = await new WorkspaceTools({
            root: settings.workspace,
            allowWrite: false,
            allowShell: false
          }).execute({
            name: "git_diff",
            arguments: {}
          });
          appendLine({
            kind: "diff",
            tone: result.ok ? "accent" : "warning",
            label: "diff",
            text: result.summary,
            detail: result.content,
            tool: "git_diff"
          });
          return;
        }
        case "approve": {
          const decision = args[0] === "session" ? "allow_session" : "allow_once";
          resolveApproval(decision);
          return;
        }
        case "deny":
          resolveApproval("deny");
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
            setInput("/connect ");
            setPaletteIndex(0);
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
          setInput("/connect ");
          setPaletteIndex(0);
          return;
        case "eject": {
          if (settings.provider !== "ollama") {
            appendLine({
              tone: "warning",
              label: "eject",
              text: "Eject is only available for Ollama models."
            });
            return;
          }

          const target = args.join(" ").trim();
          const ejectedModels = await ejectOllamaModels({
            target,
            settings,
            activeHost,
            usedModels: usedOllamaModelsRef.current
          });
          if (ejectedModels.length === 0) {
            appendLine({
              tone: "warning",
              label: "eject",
              text: "No Ollama model was ejected."
            });
            return;
          }

          appendLine({
            tone: "success",
            label: "eject",
            text: `ejected ${ejectedModels.join(", ")}`
          });
          if (activeHost) {
            const details = await readOllamaHostDetails(activeHost.host, true).catch(() => activeHost);
            setActiveHost(details);
          }
          return;
        }
        case "doctor": {
          const shouldFix = args.some((arg) => arg.toLowerCase() === "fix" || arg.toLowerCase() === "--fix");
          appendLine({
            tone: "muted",
            label: "doctor",
            text: shouldFix ? "checking local requirements and applying safe fixes..." : "checking local requirements..."
          });
          const doctorResults = await runDoctor(settings.provider, settings.ollamaUrl, settings.model, {
            fix: shouldFix
          });
          for (const result of doctorResults) {
            appendLine({
              tone: result.ok ? "success" : "danger",
              label: result.name,
              text: result.action && result.action !== "check" ? `${result.action}: ${result.details}` : result.details
            });
          }
          if (!shouldFix && doctorResults.some((result) => result.action === "skipped")) {
            appendLine({
              tone: "accent",
              label: "doctor",
              text: "Some safe fixes are available. Run /doctor fix to approve them."
            });
          }
          return;
        }
        case "cleanup": {
          const target = readCleanupTarget(args[0]);
          if (!target) {
            appendLine({
              tone: "accent",
              label: "cleanup",
              text: "Choose what to clean: /cleanup cache, /cleanup sessions, /cleanup temp, or /cleanup all.",
              detail: "Sessions deletes saved workspace transcripts. Cache/temp are safe first choices."
            });
            return;
          }

          const removed = await cleanupPatchPilot(settings.workspace, target);
          if (target === "sessions" || target === "all") {
            sessionStoreRef.current = new SessionStore({
              workspace: settings.workspace
            });
            await sessionStoreRef.current.create();
            setResumeContext("");
            setLines([]);
            setAdvisorNotes([]);
            setTelemetry(null);
            setSessionTelemetry(emptySessionTelemetry());
          }
          appendLine({
            tone: "success",
            label: "cleanup",
            text: `cleaned ${removed.join(", ") || target}`
          });
          return;
        }
        case "experimental": {
          const requestedFlag = args[0]?.toLowerCase();
          const requestedValue = args[1]?.toLowerCase();
          if (!requestedFlag) {
            setExperimentalOpen(true);
            setExperimentalIndex(0);
            setInput("");
            return;
          }

          const enabled = readToggle(requestedValue, true);
          if (requestedFlag === "subagents" || requestedFlag === "agents") {
            setSettings((currentSettings) => ({
              ...currentSettings,
              subagents: enabled
            }));
          }
          savePatchPilotEnvValues({
            [`PATCHPILOT_EXPERIMENTAL_${requestedFlag.replace(/-/g, "_").toUpperCase()}`]: enabled ? "1" : "0"
          });
          setExperimentalFlags((currentFlags) => ({
            ...currentFlags,
            ...(requestedFlag === "file-analysis"
              ? { fileAnalysis: enabled }
              : requestedFlag === "memory"
                ? { memory: enabled }
                : requestedFlag === "subagents" || requestedFlag === "agents"
                  ? { subagents: enabled }
                  : {})
          }));
          appendLine({
            tone: "success",
            label: "experimental",
            text: `${requestedFlag} ${enabled ? "enabled" : "disabled"}`
          });
          return;
        }
        case "init": {
          await ensurePatchPilotGitignore(settings.workspace);
          appendLine({
            tone: "accent",
            label: "init",
            text: "starting model-driven project init",
            detail: "PatchPilot will inspect the repository and create or update PATCHPILOT.md with approval-gated writes."
          });
          await runTask(patchPilotInitPrompt, {
            mode: "build"
          });
          return;
        }
        case "clear":
          setLines([]);
          setAdvisorNotes([]);
          setTodos([]);
          setTelemetry(null);
          setResumeContext("");
          setSessionTelemetry(emptySessionTelemetry());
          setTranscriptScrollOffset(0);
          setSessionScrollOffset(0);
          return;
        case "new":
          if (isRunning) {
            appendLine({
              tone: "warning",
              label: "new",
              text: "Cannot start a new session while a run is active.",
              detail: "Stop the current run first, then use /new again."
            });
            return;
          }
          sessionStoreRef.current = new SessionStore({
            workspace: settings.workspace
          });
          await sessionStoreRef.current.create();
          setLines([]);
          setAdvisorNotes([]);
          setTodos([]);
          setTelemetry(null);
          setSessionTelemetry(emptySessionTelemetry());
          setPendingApproval(null);
          approvalResolverRef.current = null;
          setBypassConfirmation(false);
          setInput("");
          setTranscriptScrollOffset(0);
          setSessionScrollOffset(0);
          setStatus("idle");
          setWorkState("idle");
          appendLine({
            tone: "success",
            label: "new",
            text: `started session ${sessionStoreRef.current.sessionId}`
          });
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
      requestBypassMode,
      draftTokens,
      exit,
      hostOptions,
      loadHostSuggestions,
      loadProviderModels,
      modelOptions,
      isRunning,
      resolveApproval,
      sessionTelemetry,
      settings,
      telemetry
    ]
  );

  const handleSubmit = useCallback(
    async (value: string) => {
      const nextValue = value.trim();
      if (!nextValue) {
        return;
      }

      if (isRunning && nextValue.startsWith("/")) {
        await handleSlashCommand(nextValue);
        return;
      }

      if (isRunning) {
        return;
      }

      if (onboarding) {
        await handleOnboardingSubmit(nextValue);
        return;
      }

      if (nextValue.startsWith("/")) {
        const selectedItem = paletteItems[paletteIndex];
        const commandHasArgs = /^\/\S+\s+\S/.test(nextValue);
        const shouldApplySuggestion =
          selectedItem &&
          (!commandHasArgs || selectedItem.command !== selectedItem.label) &&
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
    void sessionStoreRef.current.create();
  }, []);

  useEffect(() => {
    runtimeStateRef.current.isRunning = isRunning;
    runtimeStateRef.current.hasPendingApproval = Boolean(pendingApproval || bypassConfirmation);
  }, [bypassConfirmation, isRunning, pendingApproval]);

  useEffect(() => {
    if (!props.initialTask || didRunInitialTask.current || onboarding || process.env.PATCHPILOT_ONBOARDING_COMPLETE !== "1") {
      return;
    }

    didRunInitialTask.current = true;
    void runTask(props.initialTask);
  }, [onboarding, props.initialTask, runTask]);

  useEffect(() => {
    setPaletteIndex(0);
  }, [hostOptions, input, modelOptions, onboarding, settings.model, settings.provider]);

  useEffect(() => {
    if (didOpenDefaultOnboarding.current || onboarding || process.env.PATCHPILOT_ONBOARDING_COMPLETE === "1") {
      return;
    }

    didOpenDefaultOnboarding.current = true;
    setOnboarding({
      step: "welcome"
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
      if (activeHostSyncInFlightRef.current) {
        return;
      }

      activeHostSyncInFlightRef.current = true;
      const verifiedHost = await checkOllamaHost(settings.ollamaUrl, {
        timeoutMs: 800
      });
      if (!verifiedHost) {
        if (!cancelled) {
          setActiveHost((currentHost) => (currentHost?.host.url === settings.ollamaUrl ? currentHost : null));
        }
        activeHostSyncInFlightRef.current = false;
        return;
      }

      const details = await readOllamaHostDetails(verifiedHost).catch(() => ({
        host: verifiedHost,
        models: [] as string[],
        runningModels: [],
        fetchedAt: Date.now()
      }));
      activeHostSyncInFlightRef.current = false;

      if (cancelled) {
        return;
      }

      setActiveHost(details);
      if (details.models.length > 0) {
        setModelOptions((currentModels) => (currentModels.length > 0 && currentModels.join("\n") === details.models.join("\n") ? currentModels : details.models));
      }
    }

    void syncActiveHost();
    const timer = setInterval(() => {
      void syncActiveHost();
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [settings.ollamaUrl, settings.provider]);

  useEffect(() => {
    if (onboarding || isRunning) {
      return;
    }

    const trimmedInput = input.trim();
    if (settings.provider === "ollama" && (trimmedInput === "/connect" || trimmedInput === "/hosts") && hostOptions.length === 0 && !isLoadingHosts) {
      const key = `${settings.provider}:${settings.ollamaUrl}:${trimmedInput}:hosts`;
      if (!autoLoadKeysRef.current.has(key)) {
        autoLoadKeysRef.current.add(key);
        void loadHostSuggestions(false, false);
      }
    }

    if ((trimmedInput === "/models" || trimmedInput === "/model") && modelOptions.length === 0 && !isLoadingModels) {
      const key = `${settings.provider}:${settings.ollamaUrl}:${trimmedInput}:models`;
      if (!autoLoadKeysRef.current.has(key)) {
        autoLoadKeysRef.current.add(key);
        void loadProviderModels(false);
      }
    }
  }, [hostOptions.length, input, isLoadingHosts, isLoadingModels, isRunning, loadHostSuggestions, loadProviderModels, modelOptions.length, onboarding, settings.provider]);

  useInput((inputValue, key) => {
    if (experimentalOpen) {
      if (key.upArrow) {
        setExperimentalIndex((currentIndex) => (currentIndex - 1 + experimentalFlagCount()) % experimentalFlagCount());
        return;
      }

      if (key.downArrow) {
        setExperimentalIndex((currentIndex) => (currentIndex + 1) % experimentalFlagCount());
        return;
      }

      if (inputValue === " ") {
        const flag = experimentalFlagAt(experimentalIndex);
        setExperimentalFlags((currentFlags) => {
          const nextFlags = {
            ...currentFlags,
            [flag]: !currentFlags[flag]
          };
          if (flag === "subagents") {
            setSettings((currentSettings) => ({
              ...currentSettings,
              subagents: nextFlags.subagents
            }));
          }
          savePatchPilotEnvValues({
            PATCHPILOT_EXPERIMENTAL_FILE_ANALYSIS: nextFlags.fileAnalysis ? "1" : "0",
            PATCHPILOT_EXPERIMENTAL_MEMORY: nextFlags.memory ? "1" : "0",
            PATCHPILOT_EXPERIMENTAL_SUBAGENTS: nextFlags.subagents ? "1" : "0"
          });
          return nextFlags;
        });
        return;
      }

      if (key.return || key.escape || key.leftArrow) {
        setExperimentalOpen(false);
        setInput("");
        return;
      }

      return;
    }

    if (bypassConfirmation) {
      const normalizedInput = inputValue.toLowerCase();
      if (key.tab) {
        cancelBypassMode();
        return;
      }

      if (normalizedInput === "y") {
        confirmBypassMode();
        return;
      }

      if (normalizedInput === "n" || key.escape) {
        cancelBypassMode();
        return;
      }
    }

    if (pendingApproval) {
      const normalizedInput = inputValue.toLowerCase();
      if (normalizedInput === "y") {
        resolveApproval("allow_once");
        return;
      }

      if (normalizedInput === "a") {
        resolveApproval("allow_session");
        return;
      }

      if (normalizedInput === "n" || key.escape) {
        resolveApproval("deny");
        return;
      }
    }

    if (isRunning && key.escape) {
      abortControllerRef.current?.abort();
      appendLine({
        kind: "status",
        tone: "warning",
        label: "stop",
        text: "Stopping current task..."
      });
      setStatus("stopping");
      return;
    }

    if (onboarding) {
      if (key.escape || key.leftArrow) {
        goBackOnboarding();
        return;
      }

      if (onboardingBusyMessage) {
        return;
      }

      const optionCount = onboarding.step === "model" ? selectableModels(onboardingInput, onboarding.models, formatModelLabel).length : getOnboardingOptionCount(onboarding);
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
    if (canUsePanelKeys && key.upArrow && paletteItems.length === 0) {
      const setOffset = activeScrollPane === "session" ? setSessionScrollOffset : setTranscriptScrollOffset;
      setOffset((currentOffset) => currentOffset + 1);
      return;
    }

    if (canUsePanelKeys && key.downArrow && paletteItems.length === 0) {
      const setOffset = activeScrollPane === "session" ? setSessionScrollOffset : setTranscriptScrollOffset;
      setOffset((currentOffset) => Math.max(0, currentOffset - 1));
      return;
    }

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
    const gracefulStopOrExit = (): void => {
      const now = Date.now();
      const state = runtimeStateRef.current;
      if ((state.isRunning || state.hasPendingApproval) && now - state.lastSigintAt > 1500) {
        state.lastSigintAt = now;
        abortControllerRef.current?.abort();
        approvalResolverRef.current?.("deny");
        approvalResolverRef.current = null;
        setPendingApproval(null);
        setBypassConfirmation(false);
        setInput("");
        setStatus("stopping");
        setWorkState("idle");
        appendLine({
          kind: "status",
          tone: "warning",
          label: "stop",
          text: "Stopping current task. Press Ctrl-C again to quit."
        });
        return;
      }

      void unloadUsedOllamaModels(usedOllamaModelsRef.current).finally(() => {
        process.exit(0);
      });
    };

    const unloadAndExit = (): void => {
      void unloadUsedOllamaModels(usedOllamaModelsRef.current).finally(() => {
        process.exit(0);
      });
    };

    process.on("SIGINT", gracefulStopOrExit);
    process.on("SIGTERM", unloadAndExit);
    return () => {
      process.off("SIGINT", gracefulStopOrExit);
      process.off("SIGTERM", unloadAndExit);
      void unloadUsedOllamaModels(usedOllamaModelsRef.current);
    };
  }, [appendLine]);

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
        workState={workState}
        allowWrite={settings.allowWrite}
        allowShell={settings.allowShell}
        agentMode={agentMode}
        subagents={settings.subagents}
        thinkingMode={settings.thinkingMode}
        reasoningEffort={settings.reasoningEffort}
        ollamaUrl={settings.ollamaUrl}
        telemetry={telemetry}
        sessionTelemetry={sessionTelemetry}
        draftTokens={draftTokens}
        systemStats={systemStats}
        gpuStats={gpuStats}
        activeHost={activeHost}
      />

      {experimentalOpen ? (
        <ExperimentalPanel
          flags={experimentalFlags}
          selectedIndex={experimentalIndex}
          height={bodyHeight}
        />
      ) : onboarding ? (
        <OnboardingPanel
          state={onboarding}
          height={bodyHeight}
          selectedIndex={onboardingIndex}
          input={onboardingInput}
          busyMessage={onboardingBusyMessage}
          notice={onboardingNotice}
          formatModelLabel={formatModelLabel}
          formatModelDescription={formatModelDescription}
          onInputChange={setOnboardingInput}
          onInputSubmit={(value) => void handleOnboardingSubmit(value)}
        />
      ) : (
        <Box flexDirection="row" height={bodyHeight} overflowY="hidden">
          <Sidebar
            workspace={settings.workspace}
            model={settings.model}
            provider={settings.provider}
            ollamaUrl={settings.ollamaUrl}
            agentMode={agentMode}
            allowWrite={settings.allowWrite}
            allowShell={settings.allowShell}
            subagents={settings.subagents}
            workState={workState}
            sessionId={sessionStoreRef.current.sessionId}
            systemStats={systemStats}
            gpuStats={gpuStats}
            telemetry={telemetry}
            sessionTelemetry={sessionTelemetry}
            draftTokens={draftTokens}
            height={bodyHeight}
            scrollOffset={sessionScrollOffset}
            advisors={advisorNotes}
            isActive={activeScrollPane === "session"}
            activeHost={activeHost}
          />
          <Box flexDirection="column" flexGrow={1} height={bodyHeight} overflowY="hidden">
            <Transcript
              lines={lines}
              isRunning={isRunning}
              isActive={activeScrollPane === "transcript"}
              height={transcriptHeight}
              width={transcriptWidth}
              scrollOffset={transcriptScrollOffset}
              todos={todos}
              todoFrame={todoFrame}
              status={status}
              workState={workState}
              isApprovalWaiting={Boolean(pendingApproval || bypassConfirmation)}
            />
            <ApprovalPanel request={pendingApproval} bypassConfirmation={bypassConfirmation} />
            <Composer
              input={input}
              isRunning={isRunning}
              status={status}
              workState={workState}
              draftTokens={draftTokens}
              width={transcriptWidth}
              isApprovalWaiting={Boolean(pendingApproval || bypassConfirmation)}
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
  const cacheKey = modelCacheKey(provider, ollamaUrl);
  const cachedModels = modelCache.get(cacheKey);
  if (!refresh && cachedModels && cachedModels.expiresAt > Date.now()) {
    rememberModelDescriptors(cachedModels.descriptors);
    setModelOptions(cachedModels.models);
    return cachedModels.models;
  }

  const client = createModelClient({
    provider,
    ollamaUrl
  });
  const descriptors = client.listModelDescriptors
    ? await client.listModelDescriptors()
    : (await client.listModels()).map((model) => ({ id: model, displayName: model }));
  const models = descriptors.map((model) => model.id);
  rememberModelDescriptors(descriptors);
  modelCache.set(cacheKey, {
    models,
    descriptors,
    expiresAt: Date.now() + modelCacheTtlMs
  });
  setModelOptions(models);
  return models;
}

function modelCacheKey(provider: ModelProvider, ollamaUrl: string): string {
  if (provider === "ollama") {
    return `${provider}:${ollamaUrl}`;
  }

  if (provider === "gemini-wrapper") {
    return [
      provider,
      readGeminiWrapperMode(),
      readGeminiWrapperBaseUrl() || "python",
      readGeminiWrapperPythonCommand(),
      readGeminiWrapperCookiesJson()
    ].join(":");
  }

  return `${provider}:default`;
}

function rememberModelDescriptors(descriptors: ModelDescriptor[]): void {
  for (const descriptor of descriptors) {
    modelDescriptorIndex.set(descriptor.id, descriptor);
    if (descriptor.modelName) {
      modelDescriptorIndex.set(descriptor.modelName, descriptor);
    }
    if (descriptor.displayName) {
      modelDescriptorIndex.set(descriptor.displayName, descriptor);
    }
  }
}

async function loadKnownOrAvailableModels(
  provider: ModelProvider,
  ollamaUrl: string,
  modelOptions: string[],
  setModelOptions: React.Dispatch<React.SetStateAction<string[]>>,
  appendLine: (line: LogLineInput) => void,
  options: {
    refresh?: boolean;
  } = {}
): Promise<string[] | null> {
  try {
    return !options.refresh && modelOptions.length > 0 ? modelOptions : await loadAvailableModels(provider, ollamaUrl, setModelOptions, options.refresh);
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
  appendLine: (line: LogLineInput) => void,
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

  if (!installedModels.includes(nextModel) && !canUseUnverifiedCloudModel(provider, nextModel)) {
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
            : provider === "gemini-wrapper"
              ? "Check PATCHPILOT_GEMINI_WRAPPER_BASE_URL in PatchPilot config."
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
    tone: installedModels.includes(nextModel) ? "success" : "warning",
    label: "model",
    text: installedModels.includes(nextModel) ? `switched to ${formatModelLabel(nextModel)}` : `switched to unverified ${provider} model ${nextModel}`,
    detail: installedModels.includes(nextModel) ? undefined : "The provider did not list this model in discovery. PatchPilot will try it and surface the provider error if it is unavailable."
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
  appendLine: (line: LogLineInput) => void,
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

  if (installedModels.includes(settings.model) || canUseUnverifiedCloudModel(settings.provider, settings.model)) {
    if (!installedModels.includes(settings.model)) {
      appendLine({
        tone: "warning",
        label: "model",
        text: `using unverified ${settings.provider} model ${settings.model}`,
        detail: "Model discovery did not list it; the next provider request will be the compatibility check."
      });
    }
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
            : settings.provider === "gemini-wrapper"
              ? "No Gemini-Wrapper models listed. Check gemini_webapi install and PATCHPILOT_GEMINI_WRAPPER_COOKIES_JSON in PatchPilot config."
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

  if (trimmedInput.startsWith("/models ") || trimmedInput.startsWith("/model ")) {
    const modelQuery = trimmedInput.replace(/^\/models?/, "").trim();
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
        ...selectableModels(modelQuery, options.modelOptions, formatModelLabel).slice(0, 8).map((model) => ({
          key: `model-${model}`,
          category: "model",
          label: formatModelLabel(model),
          detail: `${model === options.currentModel ? "current" : "available"}  ${options.provider}${formatModelDescription(model)}`,
          command: `/model ${model}`,
          execute: true
        }))
      );
    }
  }

  return items;
}

function getOnboardingOptionCount(onboarding: OnboardingState): number {
  switch (onboarding.step) {
    case "welcome":
      return 1;
    case "entry":
      return 7;
    case "host":
      return onboarding.hosts.length + 1;
    case "api-key-choice":
      if (onboarding.provider === "gemini-wrapper") {
        return onboarding.hasExistingKey ? 3 : 2;
      }
      return onboarding.hasExistingKey ? 2 : 1;
    case "gemini-wrapper-model-mode":
      return geminiWrapperShortcutModels.length + 1;
    case "model":
      return onboarding.models.length;
    default:
      return 0;
  }
}

function readEntrySelection(value: string, selectedIndex: number): "local" | "host" | "gemini" | "gemini-wrapper" | "openrouter" | "nvidia" | "codex" | null {
  const normalizedValue = value.trim().toLowerCase();
  if (!normalizedValue) {
    return ["local", "host", "gemini", "gemini-wrapper", "openrouter", "nvidia", "codex"][selectedIndex] as "local" | "host" | "gemini" | "gemini-wrapper" | "openrouter" | "nvidia" | "codex";
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

  if (normalizedValue === "4" || normalizedValue === "gemini-wrapper" || normalizedValue === "geminiwrapper" || normalizedValue === "google-wrapper") {
    return "gemini-wrapper";
  }

  if (normalizedValue === "5" || normalizedValue === "openrouter" || normalizedValue === "open-router") {
    return "openrouter";
  }

  if (normalizedValue === "6" || normalizedValue === "nvidia" || normalizedValue === "nim") {
    return "nvidia";
  }

  if (normalizedValue === "7" || normalizedValue === "codex") {
    return "codex";
  }

  return null;
}

function readBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }

  const normalizedValue = value.trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(normalizedValue)) {
    return true;
  }

  if (["0", "false", "no", "off", "disabled"].includes(normalizedValue)) {
    return false;
  }

  return fallback;
}

function readIndexedSelection(value: string, selectedIndex: number): number | null {
  const normalizedValue = value.trim();
  if (!normalizedValue) {
    return selectedIndex;
  }

  const parsedIndex = Number.parseInt(normalizedValue, 10);
  return Number.isInteger(parsedIndex) ? parsedIndex - 1 : null;
}

function selectModelFromInput(value: string, models: string[], selectedIndex?: number, options: { allowManual?: boolean } = {}): string | null {
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

  if (models.includes(normalizedValue)) {
    return normalizedValue;
  }

  const labelMatch = models.find((model) => formatModelLabel(model).toLowerCase() === normalizedValue.toLowerCase());
  if (labelMatch) {
    return labelMatch;
  }

  const matches = selectableModels(normalizedValue, models, formatModelLabel);
  if (matches.length === 1) {
    return matches[0] ?? null;
  }

  return options.allowManual && isPlausibleCloudModelId(normalizedValue) ? normalizedValue : null;
}

function isPlausibleCloudModelId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(value) && value.length >= 3;
}

function canUseUnverifiedCloudModel(provider: ModelProvider, model: string): boolean {
  return provider !== "ollama" && isPlausibleCloudModelId(model);
}

function defaultModelForProvider(provider: ModelProvider, currentModel: string): string {
  if (provider === "nvidia") {
    return currentModel.includes("/") && !currentModel.startsWith("openrouter/") ? currentModel : defaultNvidiaModel;
  }

  if (provider === "openrouter") {
    return currentModel.includes("/") ? currentModel : defaultOpenRouterModel;
  }

  if (provider === "gemini-wrapper") {
    return geminiWrapperCuratedModels.includes(currentModel as typeof geminiWrapperCuratedModels[number]) || currentModel.startsWith("gemini-") || modelDescriptorIndex.has(currentModel) ? currentModel : defaultGeminiWrapperModel;
  }

  if (provider === "gemini") {
    return currentModel.startsWith("gemini-") ? currentModel : defaultGeminiModel;
  }

  if (provider === "codex") {
    return currentModel.includes("codex") || currentModel === "codex-mini-latest" ? currentModel : defaultCodexModel;
  }

  return currentModel.startsWith("gemini-") || currentModel.includes("codex") || currentModel.includes("/") ? defaultOllamaModel : currentModel;
}

function openApiKeyChoice(
  provider: ApiKeyProvider,
  setOnboarding: React.Dispatch<React.SetStateAction<OnboardingState | null>>,
  setOnboardingIndex: React.Dispatch<React.SetStateAction<number>>
): void {
  setOnboarding({
    step: "api-key-choice",
    provider,
    hasExistingKey: hasApiKey(provider)
  });
  setOnboardingIndex(0);
}

function needsApiKey(provider: ModelProvider): provider is ApiKeyProvider {
  return provider === "gemini" || provider === "gemini-wrapper" || provider === "openrouter" || provider === "nvidia";
}

function hasApiKey(provider: ApiKeyProvider): boolean {
  if (provider === "gemini") {
    return Boolean(readGeminiApiKey());
  }

  if (provider === "gemini-wrapper") {
    const baseUrl = readGeminiWrapperBaseUrl();
    if (readGeminiWrapperMode() === "http") {
      return !geminiWrapperRequiresApiKey(baseUrl) || Boolean(readGeminiWrapperApiKey());
    }

    return Boolean(readGeminiWrapperCookiesJson());
  }

  if (provider === "openrouter") {
    return Boolean(readOpenRouterApiKey());
  }

  return Boolean(readNvidiaApiKey());
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

async function ejectOllamaModels(options: {
  target: string;
  settings: AgentRunnerOptions;
  activeHost: OllamaHostDetails | null;
  usedModels: Set<string>;
}): Promise<string[]> {
  const target = options.target.trim();
  const client = new OllamaClient(options.settings.ollamaUrl);
  const models =
    target === "all"
      ? [
          ...new Set([
            ...[...options.usedModels]
              .map((entry) => entry.split("|"))
              .filter(([url]) => url === options.settings.ollamaUrl)
              .map(([, model]) => model)
              .filter((model): model is string => Boolean(model)),
            ...(options.activeHost?.runningModels.map((model) => model.name) ?? [])
          ])
        ]
      : [target || options.settings.model];

  const ejected: string[] = [];
  for (const model of models) {
    await client.unloadModel(model).then(
      () => {
        ejected.push(model);
        options.usedModels.delete(`${options.settings.ollamaUrl}|${model}`);
      },
      () => undefined
    );
  }

  return ejected;
}

function isReasoningEffort(value: string | undefined): value is AgentRunnerOptions["reasoningEffort"] {
  return value === "none" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "adaptive";
}

function upsertAdvisorNote(notes: AdvisorNote[], nextNote: AdvisorNote): AdvisorNote[] {
  const nextNotes = notes.filter((note) => note.role !== nextNote.role);
  return [...nextNotes, nextNote].slice(-2);
}

function eventToLine(event: AgentEvent): LogLineInput {
  switch (event.type) {
    case "status":
      return {
        kind: "status",
        tone: "muted",
        label: event.workState,
        text: event.message,
        workState: event.workState
      };
    case "assistant":
      return {
        kind: "assistant",
        tone: "accent",
        label: "pilot",
        text: event.message,
        workState: event.workState
      };
    case "subagent":
      return {
        kind: "assistant",
        tone: "accent",
        label: event.role,
        text: "advisor brief updated",
        detail: event.message,
        workState: event.workState
      };
    case "tool":
      return {
        kind: event.name === "git_diff" ? "diff" : "tool",
        tone: event.ok ? "success" : "warning",
        label: event.name,
        text: event.summary,
        detail: event.ok ? previewToolContent(event.content) : event.content,
        workState: event.workState,
        tool: event.name,
        toolCallId: event.toolCallId,
        category: event.category,
        preview: event.preview
      };
    case "todo":
      return {
        kind: "status",
        tone: "muted",
        label: "todo",
        text: event.summary,
        workState: event.workState
      };
    case "approval":
      return {
        kind: "approval",
        tone: event.decision === "deny" ? "warning" : "success",
        label: "approval",
        text: `${event.request.tool} ${event.decision.replace("_", " ")}`,
        detail: event.request.preview,
        workState: event.workState,
        tool: event.request.tool,
        preview: event.request.preview
      };
    case "final":
      return {
        kind: "final",
        tone: "success",
        label: "final",
        text: event.message,
        workState: event.workState
      };
    case "error":
      return {
        kind: "error",
        tone: "danger",
        label: "error",
        text: event.message,
        workState: event.workState
      };
    case "metrics":
      return {
        kind: "status",
        tone: "muted",
        label: "metrics",
        text: formatTokens(event.metrics),
        workState: event.workState
      };
  }
}

function previewToolContent(content: string | undefined): string | undefined {
  const value = content?.trim();
  if (!value) {
    return undefined;
  }

  const lines = value.split(/\r?\n/);
  const preview = lines.slice(0, 6).join("\n");
  const suffix = lines.length > 6 ? `\n...[${lines.length - 6} more lines]` : "";
  return `${preview}${suffix}`;
}

function eventToStatus(event: AgentEvent): string {
  if (event.type === "status") {
    return event.message;
  }

  if (event.type === "tool") {
    return `${event.name}: ${event.summary}`;
  }

  if (event.type === "todo") {
    return event.summary;
  }

  if (event.type === "subagent") {
    return `${event.role} subagent`;
  }

  if (event.type === "approval") {
    return `${event.request.tool}: ${event.decision.replace("_", " ")}`;
  }

  return event.type;
}

function workStateForApprovalTool(tool: AgentToolName): AgentWorkState {
  const category = getToolSpec(tool).category;
  if (category === "write") {
    return "editing";
  }
  if (category === "shell" || category === "test") {
    return "verifying";
  }
  if (category === "read" || category === "search" || category === "document" || category === "git") {
    return "reading";
  }
  return "inspecting";
}

function defaultLogKind(line: LogLineInput): LogLine["kind"] {
  if (line.kind) {
    return line.kind;
  }

  if (line.label === "you") {
    return "user";
  }

  if (line.label === "error") {
    return "error";
  }

  if (line.label === "final") {
    return "final";
  }

  return "status";
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
      return `${index + 1}. ${formatModelLabel(model)}${formatModelDescription(model)}${currentMarker}`;
    })
    .join("\n");
}

function formatModelLabel(model: string): string {
  const descriptor = modelDescriptorIndex.get(model);
  const label = descriptor?.displayName || descriptor?.modelName || model;
  return label === model ? model : `${label} (${model})`;
}

function formatModelDescription(model: string): string {
  const descriptor = modelDescriptorIndex.get(model);
  if (!descriptor?.description) {
    return "";
  }

  const legacySuffix = descriptor.legacy ? " legacy" : "";
  return `  ${descriptor.description}${legacySuffix}`;
}
