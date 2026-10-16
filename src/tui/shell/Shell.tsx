import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { AgentTodoItem, AgentWorkState, ApprovalRequest, ModelProvider, SessionTelemetry } from "../../core/types.js";
import type { CommandSuggestionItem } from "./CommandPalette.js";
import { formatCompactTokens, shortenMiddle } from "../format.js";
import type { OllamaHostDetails } from "../hosts.js";
import { computeComposerLayout } from "../layout.js";
import { describeRunActivity, formatElapsed, spinnerFrameMs, spinnerGlyph, waveFrameMs } from "../runStatus.js";
import type { AgentMode, LogLine } from "../types.js";
import { GradientText, RainbowText, ShimmerText, ultraGradients } from "./AnimatedText.js";
import { useTween } from "./useTween.js";
import { extractAttachmentPaths, sanitizePastedText } from "./attachments.js";
import type { BannerInfo } from "./Banner.js";
import { composerView, deleteComposerText, insertComposerText } from "./composer.js";
import { shouldRecallForward, shouldRecallHistory } from "../promptHistory.js";
import { CommandPalette } from "./CommandPalette.js";
import { estimateCloudEquivalentCost, formatSavedCost } from "./savings.js";
import type { ContextUsageView } from "../App.js";
import type { StreamProgress } from "../transcriptEvents.js";
import { resolveLocalOpenAIBaseUrl } from "../../core/localOpenAI.js";
import { Markdown } from "../components/Markdown.js";
import { estimateTranscriptRows, FlowShell, measureTranscriptRows } from "./FlowShell.js";
import { readGitBranch } from "../gitBranch.js";
import { symbols } from "./theme.js";
import { motionEnabled, pressureColor, sparkline, trackedBar } from "../motion.js";
import { hasUltraMode, splitUltraSegments, type UltraMode } from "./ultraModes.js";

export type ShellProps = {
  provider: ModelProvider;
  model: string;
  workspace: string;
  version?: string;
  agentMode: AgentMode;
  allowWrite: boolean;
  allowShell: boolean;
  workState: AgentWorkState;
  /** The agent's latest one-line status, shown while no model call streams. */
  status: string;
  isRunning: boolean;
  streamProgress: StreamProgress | null;
  /** The answer as it is being written, before it becomes a transcript entry. */
  streamingText: string;
  contextUsage: ContextUsageView | null;
  transcriptEpoch: number;
  ultramaxxRun: boolean;
  sessionTelemetry: SessionTelemetry;
  lines: LogLine[];
  todos: AgentTodoItem[];
  todoFrame: number;
  pendingApproval: ApprovalRequest | null;
  bypassConfirmation: boolean;
  updatePrompt: {
    currentVersion: string;
    latestVersion: string;
    source: "npm" | "github";
    command: string;
  } | null;
  updateBusy: boolean;
  input: string;
  paletteItems: CommandSuggestionItem[];
  paletteIndex: number;
  rows: number;
  columns: number;
  activeHost: OllamaHostDetails | null;
  /** A settings or flags screen, shown in place of the palette while open. */
  panel?: React.ReactNode;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onAttach: (path: string) => string;
  /** Returns the recalled prompt, or null when there is nothing to recall. */
  onHistoryPrevious: (currentInput: string) => string | null;
  onHistoryNext: () => string | null;
};

/**
 * History goes to the terminal's own scrollback through `<Static>`; only the
 * live region below it redraws. While the transcript is shorter than the
 * window, the live region pads itself so the composer sits on the bottom rows
 * and the launch header stays at the top, as in a fullscreen app.
 *
 * Keyboard routing for the palette, approvals and mode switching stays in App;
 * the composer owns typing.
 */
export function Shell(props: ShellProps): React.ReactElement {
  const approvalActive = Boolean(props.pendingApproval || props.bypassConfirmation || props.updatePrompt || props.updateBusy);
  const width = Math.max(40, props.columns);
  const hostLabel = describeHost(props);
  const [branch] = useState(() => readGitBranch(props.workspace));
  const [banner] = useState<BannerInfo>(() => ({ version: props.version, model: props.model, host: hostLabel, workspace: props.workspace, columns: width }));
  const bannerShown = props.transcriptEpoch === 0 ? banner : null;
  const [, setMeasureTick] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (measureTranscriptRows(props.lines, width, bannerShown)) {
        setMeasureTick((tick) => tick + 1);
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [props.lines, width, bannerShown]);
  const staticRows = estimateTranscriptRows(props.lines, width, bannerShown);
  // One row short of the window: a frame as tall as the terminal makes Ink
  // clear and repaint the whole screen on every update, which flickers.
  const liveMinHeight = Math.max(0, props.rows - 1 - staticRows);
  // The streamed answer can outgrow the screen long before it is complete;
  // only its tail is shown live, the full text lands in scrollback at the end.
  const streamingRows = Math.max(3, props.rows - 12 - (props.todos.length > 0 ? Math.min(props.todos.length, 7) + 2 : 0));

  return (
    <>
      {/* Static must be the first child and outside any height-bounded box. */}
      <FlowShell lines={props.lines} transcriptEpoch={props.transcriptEpoch} columns={width} banner={banner} />
      <Box flexDirection="column" minHeight={liveMinHeight}>
        <Box flexGrow={1} />
        {props.streamingText ? (
          <Box flexDirection="column" paddingLeft={2} marginTop={1}>
            <Markdown text={tailLines(props.streamingText, streamingRows)} width={width - 4} />
          </Box>
        ) : null}
        {props.todos.length > 0 ? <TodoDock todos={props.todos} todoFrame={props.todoFrame} width={width} /> : null}
        {props.updatePrompt || props.updateBusy ? (
          <UpdatePrompt prompt={props.updatePrompt} busy={props.updateBusy} />
        ) : approvalActive ? (
          <ApprovalPrompt request={props.pendingApproval} bypassConfirmation={props.bypassConfirmation} width={width} />
        ) : null}
        {props.panel}
        <Composer
          input={props.input}
          isRunning={props.isRunning}
          streamProgress={props.streamProgress}
          ultramaxxRun={props.ultramaxxRun}
          approvalActive={approvalActive}
          paletteOpen={props.paletteItems.length > 0}
          workState={props.workState}
          status={props.status}
          width={width}
          onAttach={props.onAttach}
          onChange={props.onChange}
          onSubmit={props.onSubmit}
          onHistoryPrevious={props.onHistoryPrevious}
          onHistoryNext={props.onHistoryNext}
        />
        {props.paletteItems.length > 0 ? (
          <CommandPalette items={props.paletteItems} selectedIndex={props.paletteIndex} query={props.input} />
        ) : (
          <StatusBar {...props} width={width} hostLabel={hostLabel} branch={branch} approvalActive={approvalActive} />
        )}
      </Box>
    </>
  );
}

function describeHost(props: Pick<ShellProps, "provider" | "activeHost">): string {
  // Naming the provider twice tells the user nothing; the endpoint does.
  return props.provider === "ollama" ? props.activeHost?.host.deviceName ?? "ollama" : readEndpointLabel(resolveLocalOpenAIBaseUrl());
}

function tailLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  return lines.length <= maxLines ? text : lines.slice(-maxLines).join("\n");
}

function UpdatePrompt(props: { prompt: ShellProps["updatePrompt"]; busy: boolean }): React.ReactElement {
  const frame = useSpinnerFrame(props.busy);
  const command = props.prompt?.command ?? "npm install -g @jx-grxf/patchpilot@latest";

  return (
    <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1} marginTop={1}>
      {props.busy ? (
        <>
          <Text>
            <Text color="cyan">{spinnerGlyph(frame)}</Text> Updating PatchPilot
          </Text>
          <Text color="gray">{command}</Text>
        </>
      ) : (
        <>
          <Text>
            <Text color="cyan" bold>
              {symbols.update} Update available
            </Text>
            <Text color="gray">
              {"  "}
              {props.prompt?.currentVersion ?? "-"} {symbols.arrow} {props.prompt?.latestVersion ?? "-"}
            </Text>
          </Text>
          <Text color="gray">{command}</Text>
          <KeyHints hints={[["y", "install"], ["n", "skip"]]} />
        </>
      )}
    </Box>
  );
}

function ApprovalPrompt(props: { request: ApprovalRequest | null; bypassConfirmation: boolean; width: number }): React.ReactElement | null {
  if (props.bypassConfirmation) {
    return (
      <Box borderStyle="round" borderColor="red" flexDirection="column" paddingX={1} marginTop={1}>
        <Text color="red" bold>
          {symbols.approval} Turn on bypass?
        </Text>
        <Text>Writes and shell commands will run without asking, for the rest of this session.</Text>
        <Text color="gray">Workspace path guards and the destructive-command guard still apply.</Text>
        <KeyHints hints={[["y", "turn on"], ["n", "stay in build"], ["tab", "back to plan"]]} />
      </Box>
    );
  }

  const request = props.request;
  if (!request) {
    return null;
  }

  const target = approvalTarget(request.arguments, props.width - 8);
  return (
    <Box borderStyle="round" borderColor="yellow" flexDirection="column" paddingX={1} marginTop={1}>
      <Box justifyContent="space-between">
        <Text color="yellow" bold>
          {symbols.approval} Allow {request.tool}?
        </Text>
        <Text color="gray">
          {request.permission} · {request.risk} risk
        </Text>
      </Box>
      <Text wrap="truncate">{request.preview}</Text>
      {target ? (
        <Text wrap="truncate">
          <Text color="gray">{target.kind === "command" || target.kind === "script" ? "$ " : ""}</Text>
          <Text color="cyan">{target.value}</Text>
        </Text>
      ) : null}
      <KeyHints hints={[["y", "allow once"], ["a", "allow for session"], ["n", "deny"]]} />
    </Box>
  );
}

function KeyHints(props: { hints: Array<[string, string]> }): React.ReactElement {
  return (
    <Text>
      {props.hints.map(([key, label], index) => (
        <Text key={key}>
          {index > 0 ? <Text color="gray">{"   "}</Text> : null}
          <Text bold>{key}</Text>
          <Text color="gray"> {label}</Text>
        </Text>
      ))}
    </Text>
  );
}

function TodoDock(props: { todos: AgentTodoItem[]; todoFrame: number; width: number }): React.ReactElement {
  const completed = props.todos.filter((todo) => todo.status === "completed").length;
  const allDone = completed === props.todos.length;
  const visible = props.todos.slice(0, 7);

  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={2}>
      <Text>
        <Text bold>Plan </Text>
        <Text color={allDone ? "green" : "gray"}>{trackedBar(completed / Math.max(1, props.todos.length), 12)}</Text>
        <Text color="gray">
          {" "}
          {completed}/{props.todos.length}
        </Text>
      </Text>
      {visible.map((todo) => {
        const active = todo.status === "in_progress";
        const done = todo.status === "completed";
        return (
          <Text key={todo.id} wrap="truncate">
            <Text color={done ? "green" : active ? "yellow" : "gray"}>
              {done ? symbols.todoDone : active ? symbols.todoActive : symbols.todoPending}{" "}
            </Text>
            <Text color={done ? "gray" : "white"} bold={active} strikethrough={done}>
              {todo.content}
            </Text>
          </Text>
        );
      })}
      {props.todos.length > visible.length ? <Text color="gray">  +{props.todos.length - visible.length} more</Text> : null}
    </Box>
  );
}

/** The run line ticks faster than the spinner so the shimmer glides. */
const runFrameMs = 70;

function useSpinnerFrame(active: boolean, intervalMs = spinnerFrameMs): number {
  const [frame, setFrame] = useState(0);
  const animate = motionEnabled() && active;

  useEffect(() => {
    if (!animate) {
      setFrame(0);
      return;
    }

    const timer = setInterval(() => setFrame((current) => current + 1), intervalMs);
    return () => clearInterval(timer);
  }, [animate, intervalMs]);

  return frame;
}

function Composer(props: {
  input: string;
  isRunning: boolean;
  streamProgress: StreamProgress | null;
  ultramaxxRun: boolean;
  approvalActive: boolean;
  paletteOpen: boolean;
  workState: AgentWorkState;
  status: string;
  width: number;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onAttach: (path: string) => string;
  onHistoryPrevious: (currentInput: string) => string | null;
  onHistoryNext: () => string | null;
}): React.ReactElement {
  const [runningSince, setRunningSince] = useState<number | null>(null);
  const [cursor, setCursor] = useState(props.input.length);
  const layout = computeComposerLayout({ input: props.input, width: props.width, promptWidth: 2, minHeight: 2, maxHeight: 7 });
  // Ultra keywords keep their gradient flowing while typed.
  const frame = useSpinnerFrame(props.isRunning || hasUltraMode(props.input), props.isRunning ? runFrameMs : waveFrameMs);

  useEffect(() => {
    setRunningSince((current) => (props.isRunning ? current ?? Date.now() : null));
  }, [props.isRunning]);

  // Keep the cursor valid when the draft is replaced from outside (submit,
  // slash-command fill, /clear).
  useEffect(() => {
    setCursor((current) => Math.min(current, props.input.length));
  }, [props.input]);

  const typingActive = !props.isRunning && !props.approvalActive;
  useInput(
    (value, key) => {
      const safeCursor = Math.max(0, Math.min(cursor, props.input.length));

      if (key.return) {
        if (key.shift || key.meta || key.super) {
          const next = insertComposerText(props.input, safeCursor, "\n");
          props.onChange(next.input);
          setCursor(next.cursor);
          return;
        }

        props.onSubmit(props.input);
        return;
      }

      // Up and Down move the caret inside a multi-line prompt, and recall
      // history only from the first or last line respectively — the rule every
      // shell uses, so muscle memory carries over.
      if (key.upArrow && !props.paletteOpen && shouldRecallHistory(props.input, safeCursor)) {
        const recalled = props.onHistoryPrevious(props.input);
        if (recalled !== null) {
          props.onChange(recalled);
          setCursor(recalled.length);
        }
        return;
      }

      if (key.downArrow && !props.paletteOpen && shouldRecallForward(props.input, safeCursor)) {
        const recalled = props.onHistoryNext();
        if (recalled !== null) {
          props.onChange(recalled);
          setCursor(recalled.length);
        }
        return;
      }

      if (key.leftArrow) {
        setCursor(Math.max(0, safeCursor - 1));
        return;
      }

      if (key.rightArrow) {
        setCursor(Math.min(props.input.length, safeCursor + 1));
        return;
      }

      if (key.home || (key.ctrl && value === "a")) {
        setCursor(0);
        return;
      }

      if (key.end || (key.ctrl && value === "e")) {
        setCursor(props.input.length);
        return;
      }

      if (key.backspace) {
        const next = deleteComposerText(props.input, safeCursor, "backward");
        props.onChange(next.input);
        setCursor(next.cursor);
        return;
      }

      if (key.delete) {
        const next = deleteComposerText(props.input, safeCursor, "forward");
        props.onChange(next.input);
        setCursor(next.cursor);
        return;
      }

      if (key.tab || key.escape || key.upArrow || key.downArrow || key.pageUp || key.pageDown || key.ctrl || value.length === 0) {
        return;
      }

      // Normalise pasted text so a multi-line paste cannot corrupt the editor.
      const pasted = sanitizePastedText(value);
      // Pasted paths to images / documents become attachment chips.
      const attachmentPaths = extractAttachmentPaths(pasted);
      if (attachmentPaths) {
        const chip = `${attachmentPaths.map((path) => props.onAttach(path)).join(" ")} `;
        const next = insertComposerText(props.input, safeCursor, chip);
        props.onChange(next.input);
        setCursor(next.cursor);
        return;
      }

      const next = insertComposerText(props.input, safeCursor, pasted);
      props.onChange(next.input);
      setCursor(next.cursor);
    },
    { isActive: typingActive }
  );

  // Recent throughput samples for the sparkline. A ref rather than state: this
  // feeds a render that already happens every frame, and making it state would
  // schedule a second one.
  const throughputRef = useRef<number[]>([]);
  if (props.streamProgress?.tokensPerSecond != null) {
    const samples = throughputRef.current;
    if (samples[samples.length - 1] !== props.streamProgress.tokensPerSecond) {
      samples.push(props.streamProgress.tokensPerSecond);
      if (samples.length > 32) {
        samples.shift();
      }
    }
  } else if (!props.isRunning && throughputRef.current.length > 0) {
    throughputRef.current = [];
  }

  const safeCursor = Math.max(0, Math.min(cursor, props.input.length));
  const editorRows = typingActive ? layout.editorRows : 1;
  const view = composerView(props.input, safeCursor, layout.inputWidth, editorRows);
  const rows: React.ReactNode[] = [];

  if (!typingActive) {
    rows.push(
      <Text key="locked" color="gray" wrap="truncate">
        {symbols.user} {props.approvalActive ? "Answer the prompt above to continue" : "Working — esc to interrupt"}
      </Text>
    );
  } else if (props.input.length === 0) {
    rows.push(
      <Box key="placeholder">
        <Text color="white">{symbols.user} </Text>
        <Text inverse>D</Text>
        <Text color="gray">escribe a task, or type / for commands</Text>
      </Box>
    );
  } else {
    view.rows.forEach((row, index) => {
      rows.push(
        <Box key={`editor-${index}`}>
          <Box width={2}>
            <Text color="white">{index === 0 && view.hiddenAbove === 0 ? symbols.user : " "}</Text>
          </Box>
          {index === view.cursorRow ? <ComposerCursorRow text={row} cursorCol={view.cursorCol} frame={frame} /> : <ComposerRow text={row} frame={frame + index} />}
        </Box>
      );
    });
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      {props.isRunning ? (
        <RunLine
          frame={frame}
          elapsedMs={runningSince ? Date.now() - runningSince : 0}
          workState={props.workState}
          status={props.status}
          progress={props.streamProgress}
          throughput={throughputRef.current}
          ultramaxx={props.ultramaxxRun}
        />
      ) : null}
      <Text color="gray">{"─".repeat(props.width)}</Text>
      <Box flexDirection="column">{rows}</Box>
      <Text color="gray">{"─".repeat(props.width)}</Text>
    </Box>
  );
}

function RunLine(props: {
  frame: number;
  elapsedMs: number;
  workState: AgentWorkState;
  status: string;
  progress: StreamProgress | null;
  throughput: number[];
  ultramaxx: boolean;
}): React.ReactElement {
  const activity = describeRunActivity(props.workState, props.progress, props.status);
  const tokensPerSecond = props.progress?.phase === "generating" && props.progress.tokens > 0 ? props.progress.tokensPerSecond : null;
  const figures = [formatElapsed(props.elapsedMs), activity.detail, tokensPerSecond != null ? `${tokensPerSecond.toFixed(1)} tok/s` : ""]
    .filter(Boolean)
    .join(" · ");

  return (
    <Box marginBottom={1}>
      <Text wrap="truncate">
        <Text color={props.ultramaxx ? "magenta" : "cyan"}>{spinnerGlyph(Math.floor((props.frame * runFrameMs) / spinnerFrameMs))} </Text>
        {props.ultramaxx ? (
          <RainbowText text={`${activity.label}…`} frame={props.frame} bold />
        ) : (
          <ShimmerText text={`${activity.label}…`} frame={props.frame} animate={motionEnabled()} />
        )}
        <Text color="gray"> ({figures})</Text>
        {/* The sparkline answers what the number cannot: is this speeding up
            or grinding to a halt. */}
        {tokensPerSecond != null && props.throughput.length > 1 ? <Text color="gray"> {sparkline(props.throughput, 8)}</Text> : null}
      </Text>
    </Box>
  );
}

function ComposerRow(props: { text: string; frame: number }): React.ReactElement {
  return (
    <Text>
      {splitUltraSegments(props.text).map((segment, index) => (
        <ComposerPart key={`seg-${index}`} text={segment.text} mode={segment.mode} frame={props.frame + index} />
      ))}
    </Text>
  );
}

/** Render a composer text part, gradient-animated when it is an ultra keyword. */
function ComposerPart(props: { text: string; mode: UltraMode | null; frame: number }): React.ReactElement {
  if (props.mode) {
    return <GradientText text={props.text} palette={ultraGradients[props.mode]} frame={props.frame} bold />;
  }

  return <Text color="white">{props.text}</Text>;
}

/**
 * Render one composer row with the block cursor at the given column, keeping
 * ultra keywords gradient-coloured around the caret.
 */
function ComposerCursorRow(props: { text: string; cursorCol: number; frame: number }): React.ReactElement {
  const col = Math.max(0, Math.min(props.cursorCol, props.text.length));
  const nodes: React.ReactNode[] = [];
  let pos = 0;
  let key = 0;
  for (const segment of splitUltraSegments(props.text)) {
    const start = pos;
    const end = pos + segment.text.length;
    if (segment.text.length > 0 && col >= start && col < end) {
      const local = col - start;
      const before = segment.text.slice(0, local);
      const at = segment.text.slice(local, local + 1) || " ";
      const after = segment.text.slice(local + 1);
      if (before) {
        nodes.push(<ComposerPart key={`p-${key++}`} text={before} mode={segment.mode} frame={props.frame} />);
      }
      nodes.push(
        <Text key={`p-${key++}`} inverse>
          {at}
        </Text>
      );
      if (after) {
        nodes.push(<ComposerPart key={`p-${key++}`} text={after} mode={segment.mode} frame={props.frame} />);
      }
    } else if (segment.text.length > 0) {
      nodes.push(<ComposerPart key={`p-${key++}`} text={segment.text} mode={segment.mode} frame={props.frame} />);
    }
    pos = end;
  }
  if (col >= props.text.length) {
    nodes.push(
      <Text key={`p-${key++}`} inverse>
        {" "}
      </Text>
    );
  }
  return <Text>{nodes}</Text>;
}

const modeStyles: Record<AgentMode, { glyph: string; label: string; color: "green" | "yellow" | "red" }> = {
  plan: { glyph: "⏸", label: "plan mode (read-only)", color: "green" },
  build: { glyph: "▸", label: "build mode (asks before changes)", color: "yellow" },
  bypass: { glyph: "▸▸", label: "bypass on (no prompts)", color: "red" }
};

/** Under the composer: where the session runs, then the mode and what keys do now. */
function StatusBar(props: ShellProps & { width: number; hostLabel: string; branch: string | null; approvalActive: boolean }): React.ReactElement {
  const mode = modeStyles[props.agentMode];
  const session = props.sessionTelemetry;
  const promptTokens = useTween(session.promptTokens);
  const responseTokens = useTween(session.responseTokens);
  const flash = useFlash(props.agentMode);
  const savedUsd = estimateCloudEquivalentCost(session.promptTokens, session.responseTokens, session.cachedPromptTokens);
  // The CLI's --apply/--allow-shell flags grant more than the mode says; that
  // is worth the width, defaults are not.
  const overrides = props.agentMode === "bypass" ? [] : [props.allowWrite ? "write" : "", props.allowShell ? "shell" : ""].filter(Boolean);
  const hint = props.isRunning ? "esc to interrupt" : props.approvalActive ? "" : "/ for commands";
  const separator = <Text color="gray"> │ </Text>;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text wrap="truncate">
        <Text bold>{shortenMiddle(projectName(props.workspace), 28)}</Text>
        {separator}
        <Text>{shortenMiddle(props.model, 32)}</Text>
        <Text color="gray"> on {shortenMiddle(props.hostLabel, 22)}</Text>
        {props.branch ? (
          <>
            {separator}
            <Text color="gray">{shortenMiddle(props.branch, 32)}</Text>
          </>
        ) : null}
        {props.contextUsage ? (
          <>
            {separator}
            <ContextMeter usage={props.contextUsage} />
          </>
        ) : null}
        {session.requests > 0 ? (
          <>
            {separator}
            <Text color="gray">
              {formatCompactTokens(Math.round(promptTokens))} in · {formatCompactTokens(Math.round(responseTokens))} out
              {savedUsd !== null && savedUsd >= 0.01 ? ` · ${formatSavedCost(savedUsd)} saved` : ""}
            </Text>
          </>
        ) : null}
      </Text>
      <Box justifyContent="space-between">
        <Box flexShrink={1}>
          <Text wrap="truncate">
            <Text color={mode.color} inverse={flash} bold={flash}>
              {flash ? " " : ""}
              {mode.glyph} {mode.label}
              {flash ? " " : ""}
            </Text>
            {overrides.length > 0 ? <Text color="red"> · {overrides.join(" + ")} always on</Text> : null}
            <Text color="gray"> · tab to cycle</Text>
          </Text>
        </Box>
        {hint ? (
          <Box flexShrink={0} marginLeft={2}>
            <Text color="gray">{hint}</Text>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}

/**
 * True for a moment after `value` changes: a tab press gets an answer at the
 * spot the eye is already on, then the label settles back.
 */
function useFlash(value: unknown, durationMs = 450): boolean {
  const [flash, setFlash] = useState(false);
  const firstRef = useRef(true);

  useEffect(() => {
    if (firstRef.current) {
      firstRef.current = false;
      return;
    }
    setFlash(true);
    const timer = setTimeout(() => setFlash(false), durationMs);
    return () => clearTimeout(timer);
  }, [value, durationMs]);

  return flash;
}

function projectName(workspace: string): string {
  return workspace.split("/").filter(Boolean).at(-1) ?? workspace;
}

/**
 * A bar rather than a bare percentage: occupancy is a quantity you glance at,
 * and colour alone cannot carry it on a monochrome terminal.
 */
function ContextMeter(props: { usage: ContextUsageView }): React.ReactElement {
  const ratio = useTween(props.usage.ratio, 420);
  const color = pressureColor(props.usage.ratio);
  return (
    <Text>
      <Text color="gray">ctx </Text>
      <Text color={color}>{trackedBar(ratio, 8)}</Text>
      <Text color={color}> {Math.round(ratio * 100)}%</Text>
    </Text>
  );
}

/** Host and port of the configured endpoint, which is what identifies it. */
function readEndpointLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function approvalTarget(args: Record<string, unknown>, maxLength: number): { kind: string; value: string } | null {
  for (const kind of ["path", "script", "command"] as const) {
    const value = args[kind];
    if (typeof value === "string" && value) {
      return { kind, value: shortenMiddle(value.replace(/\s+/g, " "), Math.max(20, maxLength)) };
    }
  }

  return null;
}
