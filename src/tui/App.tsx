import React, { useCallback, useEffect, useRef, useState } from "react";
import { statSync } from "node:fs";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { AgentRunner, type AgentRunnerOptions } from "../core/agent.js";
import { cleanupPatchPilot, readCleanupTarget } from "../core/cleanup.js";
import { describeComputeTarget } from "../core/compute.js";
import { ContextStore } from "../core/contextStore.js";
import { runDoctor } from "../core/doctor.js";
import { savePatchPilotEnvValues } from "../core/env.js";
import { createModelClient } from "../core/modelClient.js";
import { defaultLocalOpenAIModel, resolveLocalOpenAIBaseUrl } from "../core/localOpenAI.js";
import { defaultOllamaModel, OllamaClient } from "../core/ollama.js";
import { ensurePatchPilotGitignore, patchPilotInitPrompt } from "../core/projectInit.js";
import { formatThinkingSupport } from "../core/reasoning.js";
import { buildSessionRecap, buildSessionResumeContext, listWorkspaceSessions, loadSessionSummary, SessionStore } from "../core/session.js";
import { addTelemetryToSession, emptySessionTelemetry, estimateCloudEquivalentCost, estimateTokens } from "../core/tokenAccounting.js";
import type { ThinkingSetting, AgentEvent, AgentTodoItem, AgentToolName, AgentWorkState, ApprovalRequest, ModelDescriptor, ModelProvider, ModelTelemetry, PermissionDecision, SessionTelemetry } from "../core/types.js";
import { checkForPatchPilotUpdate, installPatchPilotUpdate, type UpdateCheckResult } from "../core/updateCheck.js";
import { getToolSpec, WorkspaceTools } from "../core/workspace.js";
import { ApprovalPanel } from "./components/ApprovalPanel.js";
import { clipboardHasImage, clipboardImageHint, readClipboardImage } from "../core/clipboard.js";
import { CommandSuggestions, type CommandSuggestionItem } from "./components/CommandSuggestions.js";
import { Composer, FooterHints } from "./components/Composer.js";
import { ExperimentalPanel, experimentalFlagAt, experimentalFlagCount, type ExperimentalFlag, type ExperimentalFlags } from "./components/ExperimentalPanel.js";
import { runContextSlashCommand } from "./contextCommands.js";
import { ExperimentalShell } from "./experimental/ExperimentalShell.js";
import { ThemePicker } from "./experimental/ThemePicker.js";
import { type Artifact, attachmentKindForPath, attachmentLabel, attachmentTypeForPath, formatSessionArtifactContext } from "./experimental/attachments.js";
import { describeUltraModes, parseUltraModes } from "./experimental/ultraModes.js";
import { formatCompletionSummary } from "./runStatus.js";
import { Header } from "./components/Header.js";
import { OnboardingPanel, type OnboardingState } from "./components/OnboardingPanel.js";
import { Sidebar } from "./components/Sidebar.js";
import { Transcript } from "./components/Transcript.js";
import { filterSlashCommands, formatCommandDetail, formatCommandHelp } from "./commands.js";
import { formatCost, formatSessionTokens, formatTokens, normalizeModelAlias, readToggle } from "./format.js";
import { checkOllamaHost, discoverOllamaHosts, normalizeOllamaUrl, readOllamaHostDetails, startLocalOllamaAppAndWait, type OllamaHost, type OllamaHostDetails } from "./hosts.js";
import { computeComposerLayout } from "./layout.js";
import { initialAgentMode, modeDescription, modePermissionLabel, nextAgentMode, permissionsForMode, shouldBypassApproval } from "./modes.js";
import { selectableModels } from "./modelSelection.js";
import {
  cyclePreference,
  defaultOnboardingPreferences,
  modePermissions as preferencesModePermissions,
  preferenceRows,
  preferencesEnvValues,
  readOnboardingPreferences,
  type OnboardingPreferences
} from "./onboardingPreferences.js";
import { readGpuStats, readSystemStats, type GpuStats, type SystemStats } from "./systemStats.js";
import { maxTranscriptLines, type AdvisorNote, type AgentMode, type LogLine, type LogLineInput, type ToolTelemetry } from "./types.js";

export type PatchPilotAppProps = AgentRunnerOptions & {
  initialTask?: string;
  packageVersion?: string;
};

type PaletteSuggestion = CommandSuggestionItem & {
  command: string;
  execute: boolean;
};

type UiTheme = "new" | "legacy";

type UpdatePromptState = Extract<UpdateCheckResult, { available: true }>;

const themeOptions: Array<{ value: UiTheme; label: string; description: string }> = [
  {
    value: "new",
    label: "New",
    description: "Experimental fullscreen shell: compact header, scrolling transcript, command palette, animated run status."
  },
  {
    value: "legacy",
    label: "Legacy",
    description: "Original PatchPilot TUI with the sidebar and split-pane layout."
  }
];

function readUiTheme(): UiTheme {
  return process.env.PATCHPILOT_UI_THEME?.trim().toLowerCase() === "legacy" ? "legacy" : "new";
}

const modelCacheTtlMs = 5 * 60_000;
const modelCache = new Map<string, { models: string[]; descriptors: ModelDescriptor[]; expiresAt: number }>();
const modelDescriptorIndex = new Map<string, ModelDescriptor>();

export function App(props: PatchPilotAppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [input, setInput] = useState(props.initialTask ?? "");
  const didRunInitialTask = useRef(false);
  const didOpenDefaultOnboarding = useRef(false);
  const didCheckForUpdates = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const softStopRequestedRef = useRef(false);
  const lastEscapeStopAtRef = useRef(0);
  const lastAttachmentWarningRef = useRef("");
  const sessionStoreRef = useRef(new SessionStore({ workspace: props.workspace }));
  const contextStoreRef = useRef(new ContextStore({ workspace: props.workspace, sessionId: sessionStoreRef.current.sessionId }));
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
  // Rolling session memory: short digests of earlier turns so a later prompt
  // ("now do X") still knows what the user asked for and where.
  const conversationTurnsRef = useRef<string[]>([]);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [advisorNotes, setAdvisorNotes] = useState<AdvisorNote[]>([]);
  const [todos, setTodos] = useState<AgentTodoItem[]>([]);
  const [todoFrame, setTodoFrame] = useState(0);
  const [verbTick, setVerbTick] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState("idle");
  const [streamProgress, setStreamProgress] = useState<StreamProgress | null>(null);
  const [contextUsage, setContextUsage] = useState<ContextUsageView | null>(null);
  const [workState, setWorkState] = useState<AgentWorkState>("idle");
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(null);
  const [updatePrompt, setUpdatePrompt] = useState<UpdatePromptState | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [telemetry, setTelemetry] = useState<ModelTelemetry | null>(null);
  const [sessionTelemetry, setSessionTelemetry] = useState<SessionTelemetry>(() => emptySessionTelemetry());
  const [toolTelemetry, setToolTelemetry] = useState<ToolTelemetry>(() => emptyToolTelemetry());
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
    subagents: props.subagents,
    shellMetacharacters: readBooleanEnv(process.env.PATCHPILOT_EXPERIMENTAL_SHELL_METACHARACTERS, false)
  });
  const [uiTheme, setUiTheme] = useState<UiTheme>(() => readUiTheme());
  const [themePickerOpen, setThemePickerOpen] = useState(false);
  const [themePickerIndex, setThemePickerIndex] = useState(0);
  const [ultramaxxRun, setUltramaxxRun] = useState(false);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const artifactsRef = useRef<Artifact[]>([]);
  const pendingAttachmentsRef = useRef<string[]>([]);
  // Tracks whether the "image in clipboard" hint was already shown for the
  // current clipboard contents, so the poll does not repeat it every tick.
  const clipboardHintShownRef = useRef(false);
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
    thinking: props.thinking,
    subagents: props.subagents
  });
  const draftTokens = estimateTokens(input);
  // `||` instead of `??`: some PTYs report 0 rows/columns before the first
  // resize event, which would otherwise collapse the whole layout.
  const terminalRows = stdout.rows || 40;
  const terminalColumns = stdout.columns || 120;
  const reauthPromptActive = false;
  const updatePromptActive = !reauthPromptActive && Boolean(updatePrompt || updateBusy);
  const approvalPromptActive = !reauthPromptActive && !updatePromptActive && Boolean(pendingApproval || bypassConfirmation);
  const blockingPromptActive = reauthPromptActive || updatePromptActive || approvalPromptActive;
  const paletteItems =
    !isRunning && !onboarding && !experimentalOpen && !blockingPromptActive
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
  const composerReservedHeight = onboarding || experimentalOpen ? 0 : computeComposerLayout({ input, width: transcriptWidth, promptWidth: 8 }).height;
  const footerReservedHeight = onboarding || experimentalOpen ? 0 : 1;
  const approvalReservedHeight = !onboarding && !experimentalOpen && blockingPromptActive ? 7 : 0;
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

  const pushArtifact = useCallback((artifact: Artifact): void => {
    artifactsRef.current = [...artifactsRef.current, artifact].slice(-40);
    setArtifacts(artifactsRef.current);
    void contextStoreRef.current.append({
      kind: artifact.origin === "attached" ? "attachment" : "artifact",
      source: artifact.origin === "attached" ? "user" : "tool",
      label: artifact.label,
      path: artifact.path,
      priority: artifact.origin === "attached" ? 85 : 75,
      meta: {
        artifactKind: artifact.kind,
        origin: artifact.origin
      }
    }).catch(() => undefined);
  }, []);

  // Registers a pasted document as an attachment chip; returns the chip label
  // ("[PNG #1]") for the composer to insert inline.
  const attachFile = useCallback(
    (path: string): string => {
      const kind = attachmentKindForPath(path) ?? "file";
      const type = attachmentTypeForPath(path);
      const sameType = artifactsRef.current.filter((item) => item.origin === "attached" && attachmentTypeForPath(item.path) === type).length;
      const label = attachmentLabel(kind, sameType + 1, path);
      pushArtifact({ id: Date.now() + Math.random(), kind, path, label, origin: "attached" });
      const nextPendingAttachments = [...pendingAttachmentsRef.current, path];
      pendingAttachmentsRef.current = nextPendingAttachments;
      appendLine({
        tone: "accent",
        label: "attach",
        text: `${label} attached`,
        detail: path
      });
      const warning = attachmentLimitWarning(nextPendingAttachments, settings.provider);
      if (warning && warning !== lastAttachmentWarningRef.current) {
        lastAttachmentWarningRef.current = warning;
        appendLine({
          tone: "warning",
          label: "attach",
          text: warning,
          detail: "Send large batches in smaller prompts, or ask PatchPilot to inspect the files in separate calls."
        });
      }
      return label;
    },
    [appendLine, pushArtifact, settings.provider]
  );

  // Ctrl+V: pull an image straight out of the OS clipboard, save it to a temp
  // file, and attach it — no need to save the screenshot to disk first.
  const handleClipboardImagePaste = useCallback(async (): Promise<void> => {
    appendLine({ kind: "status", tone: "muted", label: "clipboard", text: "Zwischenablage wird gelesen…" });
    const imagePath = await readClipboardImage();
    if (!imagePath) {
      appendLine({
        kind: "status",
        tone: "warning",
        label: "clipboard",
        text: "Kein Bild in der Zwischenablage gefunden.",
        detail: "Kopiere ein Bild (z. B. einen Screenshot) und drücke erneut Ctrl+V."
      });
      return;
    }

    const label = attachFile(imagePath);
    setInput((current) => {
      if (current.length === 0) {
        return `${label} `;
      }
      return `${current}${current.endsWith(" ") ? "" : " "}${label} `;
    });
    clipboardHintShownRef.current = true;
  }, [appendLine, attachFile]);

  // Watch the OS clipboard while idle: when an image appears, tell the user
  // once that they can attach it with Ctrl+V (reset when the image is gone).
  useEffect(() => {
    if (isRunning) {
      return;
    }

    let cancelled = false;
    const poll = async (): Promise<void> => {
      const present = await clipboardHasImage();
      if (cancelled) {
        return;
      }

      if (present && !clipboardHintShownRef.current) {
        clipboardHintShownRef.current = true;
        appendLine({ kind: "status", tone: "accent", label: "clipboard", text: clipboardImageHint() });
      } else if (!present) {
        clipboardHintShownRef.current = false;
      }
    };

    void poll();
    const timer = setInterval(() => void poll(), 7000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [isRunning, appendLine]);

  // Best-effort: record a document PatchPilot wrote during a run.
  const registerCreatedArtifact = useCallback(
    (path: string): void => {
      const kind = attachmentKindForPath(path);
      if (!kind || artifactsRef.current.some((item) => item.path === path)) {
        return;
      }

      const type = attachmentTypeForPath(path);
      const sameType = artifactsRef.current.filter((item) => item.origin === "created" && attachmentTypeForPath(item.path) === type).length;
      pushArtifact({
        id: Date.now() + Math.random(),
        kind,
        path,
        label: attachmentLabel(kind, sameType + 1, path),
        origin: "created"
      });
    },
    [pushArtifact]
  );

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

  // Slow run-status verb tick: the verb only advances every 10s while the fast
  // spinner glyph keeps animating, so the status line never flickers.
  useEffect(() => {
    if (!isRunning) {
      setVerbTick(randomLegacyVerbIndex());
      return;
    }

    setVerbTick(randomLegacyVerbIndex());
    const timer = setInterval(() => {
      setVerbTick((currentTick) => {
        let nextTick = randomLegacyVerbIndex();
        if (nextTick === currentTick) {
          nextTick += 1;
        }
        return nextTick;
      });
    }, 10_000);

    return () => {
      clearInterval(timer);
    };
  }, [isRunning]);

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

  const resolveUpdatePrompt = useCallback(
    async (accept: boolean): Promise<void> => {
      const pending = updatePrompt;
      if (!pending || updateBusy) {
        return;
      }

      if (!accept) {
        setUpdatePrompt(null);
        setStatus("idle");
        appendLine({
          tone: "muted",
          label: "update",
          text: `Skipped PatchPilot ${pending.latestVersion}.`,
          detail: `Manual command: ${pending.command}`
        });
        return;
      }

      setUpdateBusy(true);
      setStatus(`updating to ${pending.latestVersion}`);
      appendLine({
        tone: "accent",
        label: "update",
        text: `Running ${pending.command}`
      });
      try {
        const result = await installPatchPilotUpdate(pending.latestVersion);
        setUpdatePrompt(null);
        appendLine({
          tone: "success",
          label: "update",
          text: `⚡ Successfully updated to v${result.version}. Please restart PatchPilot.`,
          detail: result.command
        });
      } catch (error) {
        appendLine({
          tone: "danger",
          label: "update",
          text: error instanceof Error ? error.message : String(error),
          detail: `Automatic update failed. Manual command: ${pending.command}`
        });
      } finally {
        setUpdateBusy(false);
      }
    },
    [appendLine, updateBusy, updatePrompt]
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
                : "No models served by that local endpoint. Load one in your local server, then retry.",
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
      case "disclaimer":
        setOnboarding({
          step: "welcome"
        });
        return;
      case "entry":
        setOnboarding(null);
        return;
      case "host":
      case "local-url":
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
      case "preferences":
        void openModelSelection(onboarding.provider, { currentModel: onboarding.model });
        return;
      case "model":
        if (onboarding.provider === "ollama" && activeHost?.host.kind !== "local") {
          setOnboarding({
            step: "host",
            hosts: hostOptions
          });
          return;
        }

        if (onboarding.provider === "local-openai") {
          setOnboarding({
            step: "local-url"
          });
          return;
        }

        setOnboarding({
          step: "entry"
        });
    }
  }, [activeHost?.host.kind, hostOptions, onboarding, openModelSelection]);

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
          step: "disclaimer"
        });
        setOnboardingIndex(0);
        return;
      }

      if (onboarding.step === "disclaimer") {
        const normalizedValue = value.trim().toLowerCase();
        if (normalizedValue !== "y" && normalizedValue !== "yes" && normalizedValue !== "1") {
          setOnboardingNotice({
            tone: "warning",
            text: "Accept the use-at-your-own-risk notice to continue.",
            detail: "Press y to continue, or Escape to go back."
          });
          return;
        }

        savePatchPilotEnvValues({
          PATCHPILOT_DISCLAIMER_ACCEPTED: "2026-05-22"
        });
        process.env.PATCHPILOT_DISCLAIMER_ACCEPTED = "2026-05-22";
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

        setOnboarding({
          step: "local-url"
        });
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

      if (onboarding.step === "local-url") {
        const url = value.trim() || resolveLocalOpenAIBaseUrl();
        process.env.PATCHPILOT_PROVIDER = "local-openai";
        process.env.PATCHPILOT_LOCAL_URL = url;
        savePatchPilotEnvValues({
          PATCHPILOT_PROVIDER: "local-openai",
          PATCHPILOT_LOCAL_URL: url
        });
        setOnboardingNotice({
          tone: "success",
          text: `Using the local model server at ${url}.`,
          detail: "Models are listed straight from that server."
        });
        await openModelSelection("local-openai", { currentModel: defaultLocalOpenAIModel });
        return;
      }

      if (onboarding.step === "preferences") {
        const confirmIndex = preferenceRows.length;
        const selection = readIndexedSelection(value, onboardingIndex);
        if (selection !== confirmIndex) {
          return;
        }

        const prefs = onboarding.preferences;
        const permissions = preferencesModePermissions(prefs.mode);
        setTelemetry(null);
        setAgentMode(prefs.mode);
        grantedPermissionsRef.current = permissions;
        setExperimentalFlags((currentFlags) => ({ ...currentFlags, subagents: prefs.subagents }));
        setSettings((currentSettings) => ({
          ...currentSettings,
          provider: onboarding.provider,
          model: onboarding.model,
          allowWrite: permissions.allowWrite,
          allowShell: permissions.allowShell,
          thinkingMode: prefs.stepBudget,
          thinking: prefs.thinking,
          subagents: prefs.subagents
        }));
        savePatchPilotEnvValues({
          PATCHPILOT_PROVIDER: onboarding.provider,
          PATCHPILOT_MODEL: onboarding.model,
          PATCHPILOT_ONBOARDING_COMPLETE: "1",
          ...preferencesEnvValues(prefs),
          ...(onboarding.provider === "ollama" ? { PATCHPILOT_OLLAMA_URL: activeHost?.host.url ?? settings.ollamaUrl } : {})
        });
        process.env.PATCHPILOT_ONBOARDING_COMPLETE = "1";
        appendLine({
          tone: "success",
          label: "onboarding",
          text: `ready: ${onboarding.provider} using ${onboarding.model}`,
          detail: `mode ${prefs.mode} · thinking ${prefs.thinking} · steps ${prefs.stepBudget} · subagents ${prefs.subagents ? "on" : "off"}`
        });
        closeOnboarding();
        return;
      }

      const visibleModels = selectableModels(onboardingInput, onboarding.models, formatModelLabel);
      const selectedModel = visibleModels[onboardingIndex] ?? selectModelFromInput(value, visibleModels, onboardingIndex, {
        allowManual: onboarding.provider !== "ollama"
      });
      if (!selectedModel) {
        setOnboardingNotice({
          tone: "warning",
          text: "Unknown model selection. Pick a listed model."
        });
        return;
      }

      setOnboarding({
        step: "preferences",
        provider: onboarding.provider,
        model: selectedModel,
        preferences: readOnboardingPreferences()
      });
      setOnboardingInput("");
      setOnboardingIndex(preferenceRows.length);
    },
    [activeHost?.host.url, appendLine, closeOnboarding, connectToHost, loadHostSuggestions, onboarding, onboardingBusyMessage, onboardingIndex, openModelSelection, settings.ollamaUrl]
  );

  const runTask = useCallback(
    async (task: string, overrides: { mode?: AgentMode } = {}) => {
      if (!task.trim() || isRunning) {
        return;
      }

      // Ultra-modes: power-mode keywords (ultramaxx / ultracheap / ultrafocus /
      // ultraloop) found anywhere in the prompt. Several may combine; an
      // incompatible pair blocks the send so a contradictory run never starts.
      const ultra = parseUltraModes(task);
      if (ultra.conflict) {
        appendLine({
          kind: "status",
          tone: "danger",
          label: "ultra",
          text: ultra.conflict,
          detail: "Remove one of the conflicting keywords, then send again."
        });
        return;
      }

      const ultramaxx = ultra.modes.includes("maxx");
      const ultracheap = ultra.modes.includes("cheap");
      const ultrafast = ultra.modes.includes("fast");
      const ultrafocus = ultra.modes.includes("focus");
      const ultraloop = ultra.modes.includes("loop");
      // ultracheap and ultrafast both run the lean pipeline (low reasoning,
      // fixed short thinking, no advisors, capped steps).
      const ultraLean = ultracheap || ultrafast;
      const effectiveTask = ultra.modes.length > 0 ? ultra.cleaned : task;
      if (ultra.modes.length > 0 && !effectiveTask) {
        appendLine({
          tone: "warning",
          label: "ultra",
          text: `${describeUltraModes(ultra.modes)} needs an actual task after the keyword.`
        });
        return;
      }
      if (ultrafocus && !ultra.focusPath) {
        appendLine({
          tone: "warning",
          label: "ultra",
          text: "ultrafocus needs a path — write ultrafocus:src/file.ts or ultrafocus \"my dir\"."
        });
        return;
      }

      const runStartedAt = Date.now();
      softStopRequestedRef.current = false;
      lastEscapeStopAtRef.current = 0;
      setInput("");
      setTranscriptScrollOffset(0);
      setTodos([]);
      setUltramaxxRun(ultramaxx);
      setIsRunning(true);
      appendLine({
        kind: "user",
        tone: "normal",
        label: "you",
        text: task
      });
      if (ultra.modes.length > 0) {
        const engagedDetail: string[] = [];
        if (ultramaxx) {
          engagedDetail.push("ultramaxx: xhigh reasoning, expanded step budget, advisors on.");
        }
        if (ultracheap) {
          engagedDetail.push("ultracheap: low reasoning, terse output, advisors off.");
        }
        if (ultrafast) {
          engagedDetail.push("ultrafast: lowest-latency pipeline — low reasoning, fixed short thinking, advisors off.");
        }
        if (ultrafocus) {
          engagedDetail.push(`ultrafocus: the agent stays inside ${ultra.focusPath}.`);
        }
        if (ultraloop) {
          engagedDetail.push("ultraloop: expanded budget with explicit final self-check before finishing.");
        }
        appendLine({
          tone: "accent",
          label: "ultra",
          text: `✻ ${describeUltraModes(ultra.modes).toUpperCase()} engaged`,
          detail: engagedDetail.join("\n")
        });
      }

      let finalMessage = "";
      let turnAttachmentPaths: string[] = [];
      try {
        const runnableSettings = await resolveRunnableSettings(settings, modelOptions, appendLine, setModelOptions, (message) => {
        });
        if (!runnableSettings) {
          return;
        }

        const abortController = new AbortController();
        abortControllerRef.current = abortController;
        const effectiveMode = overrides.mode ?? agentMode;
        // Carry earlier-turn context forward so a follow-up prompt still knows
        // what the user was doing and where. Advisory only — it never changes
        // the workspace root or restricts the agent.
        const sessionMemory =
          conversationTurnsRef.current.length > 0
            ? `Earlier in this PatchPilot session (most recent last), for continuity only — the request below still takes priority and is not restricted to these paths:\n${conversationTurnsRef.current.join("\n")}`
            : "";
        const artifactContext = formatSessionArtifactContext(artifactsRef.current);
        const persistedContext = await contextStoreRef.current
          .buildContextBlock({
            maxItems: 12,
            title: "Known session context"
          })
          .catch(() => "");
        // Ultra-mode run instructions — injected as advisory context so each
        // mode shapes the run without changing the workspace root.
        const ultraInstructions: string[] = [];
        if (ultrafocus && ultra.focusPath) {
          ultraInstructions.push(
            `ULTRAFOCUS is active. Restrict every read, edit, and command to \`${ultra.focusPath}\` and the files it directly depends on. Do not modify anything outside that path; if the task genuinely needs other files, stop and say so instead.`
          );
        }
        if (ultraloop) {
          ultraInstructions.push(
            "ULTRALOOP is active. Do not finish until the user's actual goal is fully achieved and verified — not merely attempted. Before any final answer, restate the goal, list what is done, list any remaining gap, and keep working if something is still missing."
          );
        }
        if (ultracheap) {
          ultraInstructions.push(
            "ULTRACHEAP is active. Keep output terse, avoid unnecessary tool calls, and take the most direct path to a correct result."
          );
        }
        if (ultrafast) {
          ultraInstructions.push(
            "ULTRAFAST is active. Optimise for speed: minimal reasoning, the fewest tool calls that still get it right, no exploratory detours. Answer as directly as possible."
          );
        }
        const effectiveResumeContext = [resumeContext, sessionMemory, artifactContext, persistedContext, ultraInstructions.join("\n\n")]
          .filter(Boolean)
          .join("\n\n");
        const taskRunner = new AgentRunner({
          ...runnableSettings,
          maxSteps: ultraloop
            ? Math.max(runnableSettings.maxSteps, 60)
            : ultramaxx
              ? Math.max(runnableSettings.maxSteps, 40)
              : ultraLean
                ? Math.min(runnableSettings.maxSteps, 12)
                : runnableSettings.maxSteps,
          thinking: ultramaxx ? "on" : ultraLean ? "off" : runnableSettings.thinking,
          thinkingMode: ultramaxx || ultraloop ? "adaptive" : ultraLean ? "fixed" : runnableSettings.thinkingMode,
          subagents: ultramaxx || ultraloop ? true : ultraLean ? false : runnableSettings.subagents,
          ultramaxx,
          allowExternalFileAnalysis: experimentalFlags.fileAnalysis,
          allowShellMetacharacters: experimentalFlags.shellMetacharacters,
          memoryEnabled: experimentalFlags.memory,
          mode: effectiveMode,
          signal: abortController.signal,
          shouldStopAfterStep: () => softStopRequestedRef.current,
          sessionStore: sessionStoreRef.current,
          resumeContext: effectiveResumeContext,
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

              if (
                request.bypassable !== false &&
                shouldBypassApproval({
                  mode: effectiveMode,
                  permission: request.permission,
                  permissions: runnableSettings,
                  allowExternalFileAnalysis: experimentalFlags.fileAnalysis
                })
              ) {
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
        // Hand any documents the user attached this turn to the agent so it
        // can read/analyse them with its file tools.
        const pendingAttachments = pendingAttachmentsRef.current;
        turnAttachmentPaths = pendingAttachments;
        pendingAttachmentsRef.current = [];
        const taskWithAttachments =
          pendingAttachments.length > 0
            ? `${effectiveTask}\n\n[Attached documents for this task — read or analyse them as needed with inspect_document. Paths are JSON-escaped and may contain spaces:\n${formatAttachedDocuments(pendingAttachments)}\n]`
            : effectiveTask;
        for await (const event of taskRunner.run(taskWithAttachments)) {
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
            setToolTelemetry((currentTools) => addToolTelemetry(currentTools, "subagent", true));
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
            setToolTelemetry((currentTools) => addToolTelemetry(currentTools, "update_todo", true));
            continue;
          }

          if (event.type === "final") {
            finalMessage = event.message;
          }

          // Best-effort: list documents PatchPilot wrote in the artifacts bar.
          if (event.type === "tool" && event.ok && /write|create|pdf|save|export/i.test(event.name)) {
            const created = /((?:\/|~|\.\/|[\w.-]+\/)[\w./-]+\.(?:pdf|docx?|md|txt|jsonl?|csv|ya?ml|toml|xml|html?|css|tsx?|jsx?|mjs|cjs|py|sh|zsh|bash|sql|log|diff|patch|png|jpe?g|gif|webp|bmp|heic|svg))/i.exec(
              `${event.summary ?? ""} ${event.preview ?? ""}`
            );
            if (created?.[1]) {
              registerCreatedArtifact(created[1]);
            }
          }

          if (event.type === "tool") {
            setToolTelemetry((currentTools) => addToolTelemetry(currentTools, event.name, event.ok));
          }

          if (event.type === "approval") {
            setToolTelemetry((currentTools) => addApprovalTelemetry(currentTools, event.decision));
          }

          if (event.type === "context") {
            setContextUsage({
              usedTokens: event.usedTokens,
              limitTokens: event.limitTokens,
              ratio: event.ratio,
              pressure: event.pressure
            });
            continue;
          }

          if (event.type === "stream") {
            setStreamProgress({
              phase: event.phase,
              elapsedMs: event.elapsedMs,
              tokens: event.tokens,
              tokensPerSecond: event.tokensPerSecond
            });
            setStatus(eventToStatus(event));
            continue;
          }

          setStreamProgress(null);
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

        const message = error instanceof Error ? error.message : String(error);
        appendLine({
          kind: "error",
          tone: "danger",
          label: "error",
          text: message,
          workState: "error"
        });
      } finally {
        abortControllerRef.current = null;
        setIsRunning(false);
        setUltramaxxRun(false);
        // Record a short digest of this turn for cross-run continuity.
        conversationTurnsRef.current = [
          ...conversationTurnsRef.current,
          `- Asked: "${task.replace(/\s+/g, " ").trim().slice(0, 220)}"${
            turnAttachmentPaths.length > 0 ? ` attachments: ${turnAttachmentPaths.map(formatAttachmentDigestPath).join(", ")}` : ""
          }${
            finalMessage ? ` → outcome: ${finalMessage.replace(/\s+/g, " ").trim().slice(0, 220)}` : ""
          }`
        ].slice(-6);
        void contextStoreRef.current.append({
          kind: "turn",
          source: "user",
          label: task.replace(/\s+/g, " ").trim().slice(0, 120) || "PatchPilot turn",
          text: [
            `Asked: ${task.replace(/\s+/g, " ").trim()}`,
            turnAttachmentPaths.length > 0 ? `Attachments: ${turnAttachmentPaths.join(", ")}` : "",
            finalMessage ? `Outcome: ${finalMessage.replace(/\s+/g, " ").trim().slice(0, 500)}` : ""
          ]
            .filter(Boolean)
            .join("\n"),
          priority: turnAttachmentPaths.length > 0 ? 65 : 35
        }).catch(() => undefined);
        appendLine({
          kind: "status",
          tone: "muted",
          label: "done",
          text: `✻ ${formatCompletionSummary(Date.now() - runStartedAt, runStartedAt)}`,
          workState: "done"
        });
      }
    },
    [agentMode, appendLine, experimentalFlags, isRunning, modelOptions, registerCreatedArtifact, resumeContext, settings]
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
            text: `mode ${agentMode} | write ${modePermissionLabel(agentMode, "write", settings)} | shell ${modePermissionLabel(agentMode, "shell", settings)} | subagents ${settings.subagents ? "on" : "off"}`,
            detail: modeDescription(agentMode)
          });
          return;
        case "provider": {
          const nextProvider = args[0]?.toLowerCase();
          if (nextProvider !== "ollama" && nextProvider !== "local-openai") {
            appendLine({
              tone: "accent",
              label: "provider",
              text: `current ${settings.provider}. Use /provider ollama or local-openai.`,
              detail: "local-openai covers LM Studio, llama.cpp and vLLM over an OpenAI-compatible endpoint."
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
        case "think":
        case "thinking": {
          const nextThinking = args[0]?.toLowerCase();
          if (nextThinking !== "auto" && nextThinking !== "on" && nextThinking !== "off") {
            appendLine({
              tone: "accent",
              label: "thinking",
              text: `current ${settings.thinking}. Use /thinking auto, on, or off.`,
              detail: formatThinkingSupport(settings.provider, settings.model, settings.thinking)
            });
            return;
          }

          setSettings((currentSettings) => ({
            ...currentSettings,
            thinking: nextThinking
          }));
          savePatchPilotEnvValues({
            PATCHPILOT_THINKING: nextThinking
          });
          appendLine({
            tone: "success",
            label: "thinking",
            text: formatThinkingSupport(settings.provider, settings.model, nextThinking)
          });
          return;
        }
        case "write":
        case "apply": {
          const writeEnabled = readToggle(args[0], !settings.allowWrite);
          if (writeEnabled) {
            requestBypassMode();
            appendLine({
              tone: "warning",
              label: "write",
              text: "write bypass needs trusted-workspace confirmation"
            });
            return;
          }
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
          if (shellEnabled) {
            requestBypassMode();
            appendLine({
              tone: "warning",
              label: "shell",
              text: "shell bypass needs trusted-workspace confirmation"
            });
            return;
          }
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
              refresh: false
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
              refresh: false
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
              refresh: false
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
                    : "Load a model in your local server, or check PATCHPILOT_LOCAL_URL."
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
            kind: "status",
            tone: "accent",
            label: "status",
            text: `mode ${agentMode} · write ${modePermissionLabel(agentMode, "write", settings)} · shell ${modePermissionLabel(agentMode, "shell", settings)} · ${settings.provider}/${settings.model} · subagents ${settings.subagents ? "on" : "off"}`,
            detail: formatStatusDock({
              provider: settings.provider,
              model: settings.model,
              agentMode,
              subagents: settings.subagents,
              thinkingMode: settings.thinkingMode,
              thinking: settings.thinking,
              workspace: settings.workspace,
              ollamaUrl: settings.ollamaUrl,
              sessionId: sessionStoreRef.current.sessionId,
              activeHost,
              advisorNotes,
              toolTelemetry,
              sessionTelemetry,
              telemetry,
              draftTokens
            })
          });
          return;
        case "usage":
          appendLine({
            tone: "accent",
            label: "usage",
            text: formatUsageSummary({
              provider: settings.provider,
              model: settings.model,
              telemetry,
              sessionTelemetry,
              toolTelemetry
            }),
            detail: formatUsageDetail({
              provider: settings.provider,
              model: settings.model,
              sessionTelemetry,
              toolTelemetry
            })
          });
          return;
        case "update": {
          if (updateBusy) {
            appendLine({
              tone: "muted",
              label: "update",
              text: "A PatchPilot update is already running."
            });
            return;
          }

          setStatus("checking for updates");
          appendLine({
            tone: "muted",
            label: "update",
            text: "Checking npm and GitHub Releases for updates..."
          });
          try {
            const result = await checkForPatchPilotUpdate(props.packageVersion ?? "0.0.0");
            if (result.available) {
              setUpdatePrompt(result);
              setStatus(`update available ${result.currentVersion} -> ${result.latestVersion}`);
              appendLine({
                tone: "accent",
                label: "update",
                text: `PatchPilot ${result.latestVersion} is available.`,
                detail: `Current ${result.currentVersion} · source ${result.source} · confirm below to run ${result.command}`
              });
            } else {
              setStatus("idle");
              appendLine({
                tone: result.latestVersion ? "success" : "warning",
                label: "update",
                text: result.latestVersion
                  ? `PatchPilot ${result.currentVersion} is up to date.`
                  : "Could not reach npm or GitHub Releases.",
                detail: result.latestVersion ? `Latest published version: ${result.latestVersion} (${result.source})` : "Check your network connection and run /update again."
              });
            }
          } catch (error) {
            setStatus("idle");
            appendLine({
              tone: "danger",
              label: "update",
              text: error instanceof Error ? error.message : String(error)
            });
          }
          return;
        }
        case "recap":
        case "summary": {
          const recap = buildSessionRecap(await sessionStoreRef.current.loadEvents());
          appendLine({
            kind: "status",
            tone: "accent",
            label: "recap",
            text: recap.text,
            detail: recap.detail
          });
          return;
        }
        case "context":
        case "ctx":
        case "compact":
        case "compress":
          appendLine(
            await runContextSlashCommand({
              workspace: settings.workspace,
              sessionId: sessionStoreRef.current.sessionId,
              command: command === "compact" || command === "compress" ? "compact" : "context",
              args
            })
          );
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
            contextStoreRef.current = new ContextStore({
              workspace: settings.workspace,
              sessionId: selectedSession.sessionId
            });
            await contextStoreRef.current.bootstrapFromSession(await sessionStoreRef.current.loadEvents());
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
            setToolTelemetry(emptyToolTelemetry());
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

          const normalizedFlag = normalizeExperimentalFlag(requestedFlag);
          if (!normalizedFlag) {
            appendLine({
              tone: "warning",
              label: "experimental",
              text: `unknown flag ${requestedFlag}`,
              detail: "Use file-analysis, memory, subagents, or shell-metacharacters."
            });
            return;
          }

          const enabled = readToggle(requestedValue, true);
          if (normalizedFlag === "subagents") {
            setSettings((currentSettings) => ({
              ...currentSettings,
              subagents: enabled
            }));
          }
          savePatchPilotEnvValues({
            [experimentalFlagEnvName(normalizedFlag)]: enabled ? "1" : "0"
          });
          setExperimentalFlags((currentFlags) => ({
            ...currentFlags,
            ...(normalizedFlag === "fileAnalysis"
              ? { fileAnalysis: enabled }
              : normalizedFlag === "memory"
                ? { memory: enabled }
                : normalizedFlag === "subagents"
                  ? { subagents: enabled }
                  : { shellMetacharacters: enabled })
          }));
          appendLine({
            tone: "success",
            label: "experimental",
            text: `${experimentalFlagCommandName(normalizedFlag)} ${enabled ? "enabled" : "disabled"}`
          });
          return;
        }
        case "theme": {
          const requested = args[0]?.toLowerCase();
          if (requested === "new" || requested === "legacy") {
            setUiTheme(requested);
            savePatchPilotEnvValues({ PATCHPILOT_UI_THEME: requested });
            appendLine({
              tone: "success",
              label: "theme",
              text: `switched to the ${requested} UI`
            });
            return;
          }

          setThemePickerOpen(true);
          setThemePickerIndex(themeOptions.findIndex((option) => option.value === uiTheme));
          setInput("");
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
          setToolTelemetry(emptyToolTelemetry());
          setTranscriptScrollOffset(0);
          setSessionScrollOffset(0);
          conversationTurnsRef.current = [];
          artifactsRef.current = [];
          pendingAttachmentsRef.current = [];
          setArtifacts([]);
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
          contextStoreRef.current = new ContextStore({
            workspace: settings.workspace,
            sessionId: sessionStoreRef.current.sessionId
          });
          await sessionStoreRef.current.create();
          setLines([]);
          setAdvisorNotes([]);
          setTodos([]);
          setTelemetry(null);
          setSessionTelemetry(emptySessionTelemetry());
          setToolTelemetry(emptyToolTelemetry());
          setPendingApproval(null);
          approvalResolverRef.current = null;
          setBypassConfirmation(false);
          setInput("");
          setTranscriptScrollOffset(0);
          setSessionScrollOffset(0);
          setStatus("idle");
          setWorkState("idle");
          conversationTurnsRef.current = [];
          artifactsRef.current = [];
          pendingAttachmentsRef.current = [];
          setArtifacts([]);
          // Leave the transcript empty so the startup banner shows again,
          // exactly like a fresh launch.
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
      telemetry,
      updateBusy,
      props.packageVersion
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
    if (didCheckForUpdates.current || process.env.PATCHPILOT_UPDATE_CHECK === "0") {
      return;
    }

    didCheckForUpdates.current = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    setStatus("checking for updates");
    void checkForPatchPilotUpdate(props.packageVersion ?? "0.0.0", controller.signal)
      .then((result) => {
        if (result.available) {
          setUpdatePrompt(result);
          setStatus(`update available ${result.currentVersion} -> ${result.latestVersion}`);
        } else {
          setStatus((current) => (current === "checking for updates" ? "idle" : current));
        }
      })
      .catch(() => {
        setStatus((current) => (current === "checking for updates" ? "idle" : current));
      })
      .finally(() => {
        clearTimeout(timer);
      });

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [props.packageVersion]);

  useEffect(() => {
    runtimeStateRef.current.isRunning = isRunning;
    runtimeStateRef.current.hasPendingApproval = Boolean(pendingApproval || bypassConfirmation || updatePrompt || updateBusy);
  }, [bypassConfirmation, isRunning, pendingApproval, updateBusy, updatePrompt]);

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
    if (themePickerOpen) {
      if (key.upArrow) {
        setThemePickerIndex((currentIndex) => (currentIndex - 1 + themeOptions.length) % themeOptions.length);
        return;
      }

      if (key.downArrow) {
        setThemePickerIndex((currentIndex) => (currentIndex + 1) % themeOptions.length);
        return;
      }

      if (key.escape || key.leftArrow) {
        setThemePickerOpen(false);
        setInput("");
        return;
      }

      if (key.return) {
        const chosen = themeOptions[themePickerIndex]?.value ?? "new";
        setUiTheme(chosen);
        savePatchPilotEnvValues({ PATCHPILOT_UI_THEME: chosen });
        setThemePickerOpen(false);
        setInput("");
        appendLine({
          tone: "success",
          label: "theme",
          text: `switched to the ${chosen} UI`
        });
        return;
      }

      return;
    }

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
            PATCHPILOT_EXPERIMENTAL_SUBAGENTS: nextFlags.subagents ? "1" : "0",
            PATCHPILOT_EXPERIMENTAL_SHELL_METACHARACTERS: nextFlags.shellMetacharacters ? "1" : "0"
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
      // While the bypass confirmation is pending, tab continues the mode
      // cycle straight back to plan — no need to confirm bypass first.
      if (key.tab) {
        setInput("");
        applyMode("plan");
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

    if (updateBusy) {
      return;
    }

    if (updatePrompt) {
      const normalizedInput = inputValue.toLowerCase();
      if (normalizedInput === "y") {
        void resolveUpdatePrompt(true);
        return;
      }

      if (normalizedInput === "n" || key.escape) {
        void resolveUpdatePrompt(false);
        return;
      }

      return;
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
      const now = Date.now();
      const isDoubleEscape = now - lastEscapeStopAtRef.current <= 700;
      lastEscapeStopAtRef.current = now;

      if (isDoubleEscape) {
        abortControllerRef.current?.abort();
        appendLine({
          kind: "status",
          tone: "warning",
          label: "stop",
          text: "Force stopping current task now..."
        });
        setStatus("force stopping");
        return;
      }

      softStopRequestedRef.current = true;
      appendLine({
        kind: "status",
        tone: "warning",
        label: "stop",
        text: "Will stop after the current step. Press esc again quickly to force stop now."
      });
      setStatus("stopping after current step");
      return;
    }

    // Ctrl+V — paste an image from the OS clipboard as an attachment. Bound to
    // Ctrl+V on every platform because terminals capture ⌘V / the native paste
    // shortcut for their own text paste.
    if (key.ctrl && (inputValue === "v" || inputValue === "V") && !onboarding && !isRunning) {
      void handleClipboardImagePaste();
      return;
    }

    if (onboarding) {
      if (key.escape) {
        goBackOnboarding();
        return;
      }

      if (onboardingBusyMessage) {
        return;
      }

      // Preferences step: left/right cycle the selected row's value in place;
      // left only goes back when no row is highlighted (the confirm row).
      if (onboarding.step === "preferences") {
        const confirmIndex = preferenceRows.length;
        if ((key.leftArrow || key.rightArrow) && onboardingIndex < confirmIndex) {
          const row = preferenceRows[onboardingIndex];
          if (row) {
            setOnboarding((current) =>
              current && current.step === "preferences"
                ? { ...current, preferences: cyclePreference(current.preferences, row.key, key.leftArrow ? -1 : 1) }
                : current
            );
          }
          return;
        }
        if (key.leftArrow) {
          goBackOnboarding();
          return;
        }
      } else if (key.leftArrow) {
        goBackOnboarding();
        return;
      }

      if (onboarding.step === "disclaimer") {
        if (inputValue.toLowerCase() === "y") {
          void handleOnboardingSubmit("y");
        } else if (inputValue.toLowerCase() === "n") {
          goBackOnboarding();
        }
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

  if (themePickerOpen) {
    return (
      <Box flexDirection="column" paddingX={1} height={rootHeight} overflowY="hidden">
        <ThemePicker options={themeOptions} selectedIndex={themePickerIndex} currentValue={uiTheme} height={rootHeight - 2} />
      </Box>
    );
  }

  if (uiTheme === "new" && !experimentalOpen) {
    if (onboarding) {
      return (
        <Box flexDirection="column" paddingX={1} height={rootHeight} overflowY="hidden">
          <Box borderStyle="round" borderColor="cyan" paddingX={1}>
            <Text color="cyan" bold>
              ◆ PatchPilot
            </Text>
            <Text color="gray"> · guided setup · the new shell starts once setup is done</Text>
          </Box>
          <OnboardingPanel
            state={onboarding}
            height={rootHeight - 3}
            selectedIndex={onboardingIndex}
            input={onboardingInput}
            busyMessage={onboardingBusyMessage}
            notice={onboardingNotice}
            formatModelLabel={formatModelLabel}
            formatModelDescription={formatModelDescription}
            onInputChange={setOnboardingInput}
            onInputSubmit={(value) => void handleOnboardingSubmit(value)}
          />
        </Box>
      );
    }

    return (
      <ExperimentalShell
        provider={settings.provider}
        model={settings.model}
        workspace={settings.workspace}
        sessionId={sessionStoreRef.current.sessionId}
        agentMode={agentMode}
        allowWrite={settings.allowWrite}
        allowShell={settings.allowShell}
        subagents={settings.subagents}
        workState={workState}
        status={status}
        isRunning={isRunning}
        streamProgress={streamProgress}
        contextUsage={contextUsage}
        ultramaxxRun={ultramaxxRun}
        telemetry={telemetry}
        sessionTelemetry={sessionTelemetry}
        draftTokens={draftTokens}
        lines={lines}
        todos={todos}
        todoFrame={todoFrame}
        pendingApproval={pendingApproval}
        bypassConfirmation={bypassConfirmation}
        updatePrompt={updatePrompt}
        updateBusy={updateBusy}
        reauthActive={false}
        reauthBusy={false}
        transcriptScrollOffset={transcriptScrollOffset}
        input={input}
        paletteItems={paletteItems}
        paletteIndex={paletteIndex}
        rows={terminalRows}
        columns={terminalColumns}
        activeHost={activeHost}
        artifacts={artifacts}
        onChange={setInput}
        onSubmit={(value) => void handleSubmit(value)}
        onAttach={attachFile}
      />
    );
  }

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
        thinking={settings.thinking}
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
              verbIndex={verbTick}
              status={status}
              workState={workState}
              isApprovalWaiting={blockingPromptActive}
            />
            <UpdatePromptPanel prompt={updatePromptActive ? updatePrompt : null} busy={updatePromptActive && updateBusy} />
            <ApprovalPanel request={approvalPromptActive ? pendingApproval : null} bypassConfirmation={approvalPromptActive && bypassConfirmation} />
            <Composer
              input={input}
              isRunning={isRunning}
              status={status}
              workState={workState}
              draftTokens={draftTokens}
              width={transcriptWidth}
              isApprovalWaiting={blockingPromptActive}
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

  return `${provider}:${resolveLocalOpenAIBaseUrl()}`;
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

  if (!installedModels.includes(nextModel) && !canUseUnverifiedModel(provider, nextModel)) {
    appendLine({
      tone: "warning",
      label: "model",
      text: `${nextModel} is not available for ${provider}.`,
      detail:
        installedModels.length > 0
          ? `Use /models and pick one of:\n${formatModelOptions(installedModels, currentModel)}`
          : provider === "ollama"
            ? "No models installed on the selected host."
            : "No models served. Load one in your local server, or check PATCHPILOT_LOCAL_URL."
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
}

async function resolveRunnableSettings(
  settings: AgentRunnerOptions,
  modelOptions: string[],
  appendLine: (line: LogLineInput) => void,
  setModelOptions: React.Dispatch<React.SetStateAction<string[]>>,
  onProviderError?: (message: string) => void
): Promise<AgentRunnerOptions | null> {
  let installedModels: string[];
  try {
    installedModels = modelOptions.includes(settings.model)
      ? modelOptions
      : await loadAvailableModels(settings.provider, settings.ollamaUrl, setModelOptions);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendLine({
      tone: "danger",
      label: settings.provider,
      text: message
    });
    onProviderError?.(message);
    return null;
  }

  if (installedModels.includes(settings.model) || canUseUnverifiedModel(settings.provider, settings.model)) {
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
          : "No models served. Load one in your local server, or check PATCHPILOT_LOCAL_URL."
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
    case "disclaimer":
      return 0;
    case "entry":
      return 3;
    case "host":
      return onboarding.hosts.length + 1;
    case "local-url":
      return 0;
    case "model":
      return onboarding.models.length;
    case "preferences":
      return preferenceRows.length + 1;
    default:
      return 0;
  }
}

function readEntrySelection(value: string, selectedIndex: number): "local" | "host" | "local-openai" | null {
  const normalizedValue = value.trim().toLowerCase();
  if (!normalizedValue) {
    return ["local", "host", "local-openai"][selectedIndex] as "local" | "host" | "local-openai";
  }

  if (normalizedValue === "1" || normalizedValue === "local" || normalizedValue === "this device") {
    return "local";
  }

  if (normalizedValue === "2" || normalizedValue === "host" || normalizedValue === "remote host" || normalizedValue === "remote") {
    return "host";
  }

  if (
    normalizedValue === "3" ||
    normalizedValue === "local-openai" ||
    normalizedValue === "local server" ||
    normalizedValue === "lmstudio" ||
    normalizedValue === "lm studio" ||
    normalizedValue === "bionic" ||
    normalizedValue === "llamacpp" ||
    normalizedValue === "vllm"
  ) {
    return "local-openai";
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

function normalizeExperimentalFlag(value: string): ExperimentalFlag | null {
  switch (value.trim().toLowerCase()) {
    case "file-analysis":
    case "fileanalysis":
    case "files":
      return "fileAnalysis";
    case "memory":
      return "memory";
    case "subagents":
    case "agents":
      return "subagents";
    case "shell-metacharacters":
    case "shell-metachars":
    case "metacharacters":
    case "metachars":
    case "shell":
      return "shellMetacharacters";
    default:
      return null;
  }
}

function experimentalFlagCommandName(flag: ExperimentalFlag): string {
  return flag === "fileAnalysis"
    ? "file-analysis"
    : flag === "shellMetacharacters"
      ? "shell-metacharacters"
      : flag;
}

function experimentalFlagEnvName(flag: ExperimentalFlag): string {
  return `PATCHPILOT_EXPERIMENTAL_${experimentalFlagCommandName(flag).replace(/-/g, "_").toUpperCase()}`;
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

/**
 * Ollama can only run what it has pulled, so an unlisted id is always wrong.
 * An OpenAI-compatible server may load a model on demand, so a plausible id is
 * worth attempting rather than refusing.
 */
function canUseUnverifiedModel(provider: ModelProvider, model: string): boolean {
  return provider !== "ollama" && isPlausibleCloudModelId(model);
}

function defaultModelForProvider(provider: ModelProvider, currentModel: string): string {
  if (provider === "local-openai") {
    return modelDescriptorIndex.has(currentModel) ? currentModel : defaultLocalOpenAIModel;
  }

  return currentModel.includes("/") ? defaultOllamaModel : currentModel;
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

function upsertAdvisorNote(notes: AdvisorNote[], nextNote: AdvisorNote): AdvisorNote[] {
  const nextNotes = notes.filter((note) => note.role !== nextNote.role);
  return [...nextNotes, nextNote].slice(-2);
}

function UpdatePromptPanel(props: {
  prompt: UpdatePromptState | null;
  busy: boolean;
}): React.ReactElement | null {
  if (!props.prompt && !props.busy) {
    return null;
  }

  const command = props.prompt?.command ?? "npm install -g @jx-grxf/patchpilot@latest";
  return (
    <Box borderStyle="double" borderColor="yellow" flexDirection="column" paddingX={1}>
      <Text color="yellow" bold>
        UPDATE AVAILABLE
      </Text>
      {props.busy ? (
        <>
          <Text color="cyan">Updating PatchPilot...</Text>
          <Text color="gray">{command}</Text>
        </>
      ) : (
        <>
          <Text color="white">Install PatchPilot {props.prompt?.latestVersion} now?</Text>
          <Text color="gray">
            Current {props.prompt?.currentVersion} · source {props.prompt?.source} · {command}
          </Text>
          <Text>
            <Text color="green" bold>
              [y]
            </Text>
            <Text color="gray"> update   </Text>
            <Text color="red" bold>
              [n / esc]
            </Text>
            <Text color="gray"> skip</Text>
          </Text>
        </>
      )}
    </Box>
  );
}

function emptyToolTelemetry(): ToolTelemetry {
  return {
    total: 0,
    succeeded: 0,
    failed: 0,
    approvals: 0,
    denied: 0,
    byTool: {}
  };
}

function addToolTelemetry(current: ToolTelemetry, tool: AgentToolName | "subagent", ok: boolean): ToolTelemetry {
  return {
    ...current,
    total: current.total + 1,
    succeeded: current.succeeded + (ok ? 1 : 0),
    failed: current.failed + (ok ? 0 : 1),
    byTool: {
      ...current.byTool,
      [tool]: (current.byTool[tool] ?? 0) + 1
    }
  };
}

function addApprovalTelemetry(current: ToolTelemetry, decision: PermissionDecision): ToolTelemetry {
  return {
    ...current,
    approvals: current.approvals + (decision === "deny" ? 0 : 1),
    denied: current.denied + (decision === "deny" ? 1 : 0)
  };
}

/**
 * Dense operational status dock for `/status` — restores the always-available
 * "what mode am I in and what can happen" view the legacy sidebar provided,
 * without spending fixed screen rows in the new shell's header.
 */
function formatStatusDock(options: {
  provider: ModelProvider;
  model: string;
  agentMode: AgentMode;
  subagents: boolean;
  thinkingMode: string;
  thinking: ThinkingSetting;
  workspace: string;
  ollamaUrl: string;
  sessionId: string;
  activeHost: OllamaHostDetails | null;
  advisorNotes: AdvisorNote[];
  toolTelemetry: ToolTelemetry;
  sessionTelemetry: SessionTelemetry;
  telemetry: ModelTelemetry | null;
  draftTokens: number;
}): string {
  const isOllama = options.provider === "ollama";
  const hostLine = isOllama
    ? `${options.activeHost?.host.deviceName ?? "ollama"}  ${options.activeHost?.host.url ?? options.ollamaUrl}`
    : `${options.provider} api`;
  const computeKind = isOllama ? describeComputeTarget(options.ollamaUrl).kind : "local";
  const reasoning = `steps ${options.thinkingMode} · ${formatThinkingSupport(options.provider, options.model, options.thinking)}`;
  const toolCounters = Object.entries(options.toolTelemetry.byTool)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 6)
    .map(([tool, count]) => `${tool} ${count}`)
    .join(" · ");
  const advisors = options.advisorNotes.length > 0
    ? options.advisorNotes.map((note) => `  ${note.role}: ${note.message.replace(/\s+/g, " ").slice(0, 88)}`).join("\n")
    : "  none yet";
  return [
    `provider   ${options.provider}/${options.model}`,
    `host       ${hostLine}  ·  compute ${computeKind}  ·  tools local`,
    `mode       ${options.agentMode}  ·  write ${modePermissionLabel(options.agentMode, "write")}  ·  shell ${modePermissionLabel(options.agentMode, "shell")}`,
    `model cfg  ${reasoning}  ·  subagents ${options.subagents ? "on" : "off"}`,
    `workspace  ${options.workspace}`,
    `session    ${options.sessionId}`,
    `tokens     draft ${options.draftTokens} · last ${formatTokens(options.telemetry)} · session ${formatSessionTokens(options.sessionTelemetry)} · cost ${formatCost(options.sessionTelemetry.estimatedCostUsd)}`,
    options.toolTelemetry.total > 0
      ? `tools      ${options.toolTelemetry.total} calls · ${options.toolTelemetry.succeeded} ok · ${options.toolTelemetry.failed} failed · ${options.toolTelemetry.approvals} approved · ${options.toolTelemetry.denied} denied`
      : "tools      none yet",
    toolCounters ? `counters   ${toolCounters}` : "",
    `advisors\n${advisors}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatUsageSummary(options: {
  provider: ModelProvider;
  model: string;
  telemetry: ModelTelemetry | null;
  sessionTelemetry: SessionTelemetry;
  toolTelemetry: ToolTelemetry;
}): string {
  const session = options.sessionTelemetry;
  const cost = formatCost(session.estimatedCostUsd);
  const saved = estimateSessionSavings(session);
  const pricingNote = pricingSourceLabel(session.costSource, saved.source);
  return [
    `${session.requests} request${session.requests === 1 ? "" : "s"}`,
    `${session.promptTokens} in`,
    `${session.responseTokens} out`,
    `${session.cachedPromptTokens} cached`,
    `${options.toolTelemetry.total} tool call${options.toolTelemetry.total === 1 ? "" : "s"}`,
    `cost ${cost}`,
    saved.costUsd !== null ? `saved ${formatCost(saved.costUsd)}` : "saved -",
    pricingNote
  ].join(" · ");
}

function formatUsageDetail(options: {
  provider: ModelProvider;
  model: string;
  sessionTelemetry: SessionTelemetry;
  toolTelemetry: ToolTelemetry;
}): string {
  const session = options.sessionTelemetry;
  const saved = estimateSessionSavings(session);
  const toolRows = Object.entries(options.toolTelemetry.byTool)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([tool, count]) => `${tool}: ${count}`)
    .join("\n");
  return [
    `model: ${options.provider}/${options.model}`,
    `tokens: ${session.promptTokens} input, ${session.responseTokens} output, ${session.cachedPromptTokens} cached, ${session.cacheWriteTokens} cache-write, ${session.totalTokens} total`,
    `cost: ${formatCost(session.estimatedCostUsd)} (${session.costSource})`,
    saved.costUsd !== null ? `lifetime saved this session: ${formatCost(saved.costUsd)} (${saved.source})` : "lifetime saved this session: -",
    options.toolTelemetry.total > 0
      ? `tools: ${options.toolTelemetry.total} total, ${options.toolTelemetry.succeeded} ok, ${options.toolTelemetry.failed} failed, ${options.toolTelemetry.approvals} approved, ${options.toolTelemetry.denied} denied`
      : "tools: none yet",
    toolRows ? `tool counters:\n${toolRows}` : "",
    session.costSource === "fallback-pricing" || saved.source === "fallback-pricing"
      ? "pricing note: exact model pricing was not available, so PatchPilot used a conservative general cloud-model estimate."
      : session.costSource === "unknown"
        ? "pricing note: exact pricing is unavailable for this provider/model."
        : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function estimateSessionSavings(session: SessionTelemetry): {
  costUsd: number | null;
  source: "api-pricing" | "fallback-pricing" | "unknown";
} {
  return {
    costUsd: estimateCloudEquivalentCost(session.promptTokens, session.responseTokens, session.cachedPromptTokens),
    source: "fallback-pricing"
  };
}

function pricingSourceLabel(costSource: SessionTelemetry["costSource"], savedSource: "api-pricing" | "fallback-pricing" | "unknown"): string {
  if (costSource === "fallback-pricing" || savedSource === "fallback-pricing") {
    return "fallback pricing";
  }
  if (costSource === "unknown" && savedSource === "unknown") {
    return "pricing unknown";
  }
  if (costSource === "free-route") {
    return "free route";
  }
  if (costSource === "mixed") {
    return "mixed pricing";
  }
  return "priced";
}

const bytesPerMiB = 1024 * 1024;
/**
 * Local models are bounded by context window and VRAM rather than by an API's
 * upload rules, so these thresholds are about what a local run can actually
 * hold, not what a service will accept.
 */
const promptFileLimit = 8;
const largeFileBytes = 32 * bytesPerMiB;
const largePdfBytes = 8 * bytesPerMiB;
const totalPromptWarnBytes = 16 * bytesPerMiB;

function attachmentLimitWarning(paths: string[], provider: ModelProvider): string | null {
  if (paths.length === 0) {
    return null;
  }

  const files = paths.map((filePath) => ({
    path: filePath,
    type: attachmentTypeForPath(filePath),
    size: readFileSize(filePath)
  }));
  const knownTotalBytes = files.reduce((total, file) => total + (typeof file.size === "number" ? file.size : 0), 0);
  const largePdf = files.find((file) => file.type === "PDF" && typeof file.size === "number" && file.size > largePdfBytes);
  const largeFile = files.find((file) => typeof file.size === "number" && file.size > largeFileBytes);

  if (paths.length > promptFileLimit) {
    return `Attached ${paths.length} files. A local model holds far less context than a hosted one \u2014 split this into batches of ${promptFileLimit} or fewer.`;
  }

  if (largeFile) {
    return `${attachmentTypeForPath(largeFile.path)} file ${attachmentBasename(largeFile.path)} is over ${formatMiB(largeFileBytes)}; it will very likely overflow the model's context window.`;
  }

  if (largePdf) {
    return `${attachmentTypeForPath(largePdf.path)} file ${attachmentBasename(largePdf.path)} is over ${formatMiB(largePdfBytes)}; extraction may be slow and incomplete on local hardware.`;
  }

  if (knownTotalBytes > totalPromptWarnBytes) {
    return `Attached files total about ${formatMiB(knownTotalBytes)}; run /doctor to check the loaded context window before sending.`;
  }

  return null;
}

function readFileSize(filePath: string): number | null {
  try {
    const stats = statSync(filePath);
    return stats.isFile() ? stats.size : null;
  } catch {
    return null;
  }
}

function formatMiB(bytes: number): string {
  return `${Math.round((bytes / bytesPerMiB) * 10) / 10} MiB`;
}

function formatAttachedDocuments(paths: string[]): string {
  const counts = new Map<string, number>();
  return paths
    .map((filePath) => {
      const kind = attachmentKindForPath(filePath) ?? "file";
      const type = attachmentTypeForPath(filePath);
      const index = (counts.get(type) ?? 0) + 1;
      counts.set(type, index);
      return `- ${attachmentLabel(kind, index, filePath)} path=${JSON.stringify(filePath)}`;
    })
    .join("\n");
}

/** Last path segment, splitting on both POSIX and Windows separators. */
function attachmentBasename(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).at(-1) ?? filePath;
}

function formatAttachmentDigestPath(filePath: string): string {
  return JSON.stringify(filePath.split(/[\\/]/).filter(Boolean).at(-1) ?? filePath);
}

/** Context-window occupancy for the meter. */
export type ContextUsageView = {
  usedTokens: number;
  limitTokens: number;
  ratio: number;
  pressure: "ok" | "warn" | "high" | "critical";
};

/**
 * A percentage alone hides whether there is room for the next tool result, so
 * the meter shows the raw token counts alongside it.
 */
export function formatContextUsage(usedTokens: number, limitTokens: number, ratio: number): string {
  return `${formatTokenCount(usedTokens)}/${formatTokenCount(limitTokens)} · ${Math.round(ratio * 100)}%`;
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }

  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

/** Live progress within the current model call, or null when idle. */
export type StreamProgress = {
  phase: "prompt" | "generating";
  elapsedMs: number;
  tokens: number;
  tokensPerSecond: number | null;
};

/**
 * Prompt evaluation and generation are different waits and deserve different
 * words: during the first there is nothing to show but elapsed time, during
 * the second the throughput is the interesting number.
 */
export function formatStreamProgress(
  phase: "prompt" | "generating",
  elapsedMs: number,
  tokens: number,
  tokensPerSecond: number | null
): string {
  if (phase === "prompt") {
    return `reading prompt · ${formatDuration(elapsedMs)}`;
  }

  const rate = tokensPerSecond === null ? null : `${tokensPerSecond.toFixed(1)} tok/s`;
  return [`writing · ${tokens} tok`, rate, formatDuration(elapsedMs)].filter(Boolean).join(" · ");
}

function formatDuration(elapsedMs: number): string {
  const seconds = elapsedMs / 1000;
  if (seconds < 10) {
    return `${seconds.toFixed(1)}s`;
  }

  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }

  return `${Math.floor(seconds / 60)}m${String(Math.round(seconds % 60)).padStart(2, "0")}s`;
}

function randomLegacyVerbIndex(): number {
  return Math.floor(Math.random() * 1_000_000);
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
    case "context":
      // Drives the meter, never a transcript line.
      return {
        kind: "status",
        tone: event.pressure === "critical" ? "danger" : event.pressure === "high" ? "warning" : "muted",
        label: "context",
        text: formatContextUsage(event.usedTokens, event.limitTokens, event.ratio),
        workState: event.workState
      };
    case "thinking":
      return {
        kind: "thinking",
        tone: "muted",
        label: "thinking",
        text: event.message,
        workState: event.workState
      };
    case "stream":
      // Handled as live status, never appended; this keeps the switch total.
      return {
        kind: "status",
        tone: "muted",
        label: event.workState,
        text: formatStreamProgress(event.phase, event.elapsedMs, event.tokens, event.tokensPerSecond),
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

  if (event.type === "stream") {
    return formatStreamProgress(event.phase, event.elapsedMs, event.tokens, event.tokensPerSecond);
  }

  if (event.type === "thinking") {
    return "thinking";
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
