import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { AgentTodoItem, AgentWorkState, ApprovalRequest, ModelProvider, ModelTelemetry, SessionTelemetry } from "../../core/types.js";
import type { CommandSuggestionItem } from "../components/CommandSuggestions.js";
import { formatCost, formatSessionTokens, shortenMiddle } from "../format.js";
import type { OllamaHostDetails } from "../hosts.js";
import { computeComposerLayout } from "../layout.js";
import { formatElapsed, pulseGlyph, runStatusParts, spinnerFrameMs, spinnerGlyph, waveFrameMs } from "../runStatus.js";
import type { AgentMode, LogLine } from "../types.js";
import { RainbowText, WaveText } from "./AnimatedText.js";
import { type Artifact, attachmentSymbol, extractAttachmentPaths, sanitizePastedText } from "./attachments.js";
import { ExperimentalBanner } from "./Banner.js";
import { composerView } from "./composer.js";
import { CommandPalette } from "./CommandPalette.js";
import { estimateGeminiCost, formatSavedCost } from "./geminiPricing.js";
import { computeExperimentalLayout, windowRows } from "./layout.js";
import { symbols, workStateColor } from "./theme.js";
import { buildShellRows, buildTodoDock, truncate } from "./transcriptRows.js";
import { hasUltramaxx, splitUltramaxxSegments } from "./ultramaxx.js";

export type ExperimentalShellProps = {
  provider: ModelProvider;
  model: string;
  workspace: string;
  sessionId: string;
  agentMode: AgentMode;
  allowWrite: boolean;
  allowShell: boolean;
  subagents: boolean;
  workState: AgentWorkState;
  status: string;
  isRunning: boolean;
  ultramaxxRun: boolean;
  telemetry: ModelTelemetry | null;
  sessionTelemetry: SessionTelemetry;
  draftTokens: number;
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
  reauthActive: boolean;
  reauthBusy: boolean;
  transcriptScrollOffset: number;
  input: string;
  paletteItems: CommandSuggestionItem[];
  paletteIndex: number;
  rows: number;
  columns: number;
  activeHost: OllamaHostDetails | null;
  artifacts: Artifact[];
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onAttach: (path: string) => string;
};

/**
 * Fullscreen experimental shell — a Claude-Code / Codex-CLI flavoured layout:
 * compact header, scrolling transcript, a first-class todo dock, prominent
 * approvals, a categorized command palette, and a bottom-pinned composer.
 *
 * Purely presentational. Keyboard routing (palette navigation, approval keys,
 * scrolling, mode toggle) stays in App's central useInput; only the composer
 * owns its own typing input.
 */
export function ExperimentalShell(props: ExperimentalShellProps): React.ReactElement {
  const approvalActive = Boolean(props.pendingApproval || props.bypassConfirmation || props.reauthActive || props.updatePrompt || props.updateBusy);
  const layout = computeExperimentalLayout({
    rows: props.rows,
    columns: props.columns,
    composerInput: props.input,
    paletteItemCount: props.paletteItems.length,
    approvalActive,
    todoCount: props.todos.length,
    hasArtifacts: props.artifacts.length > 0,
  });

  return (
    <Box flexDirection="column" height={layout.rootHeight} overflowY="hidden">
      <ShellHeader {...props} />
      {layout.artifactsHeight > 0 ? <ArtifactsBar artifacts={props.artifacts} width={layout.transcriptWidth} /> : null}
      <ShellTranscript
        lines={props.lines}
        isRunning={props.isRunning}
        ultramaxxRun={props.ultramaxxRun}
        scrollOffset={props.transcriptScrollOffset}
        height={layout.transcriptHeight}
        width={layout.transcriptWidth}
      />
      {layout.todoDockHeight > 0 ? (
        <ShellTodoDock todos={props.todos} todoFrame={props.todoFrame} height={layout.todoDockHeight} width={layout.transcriptWidth} />
      ) : null}
      {props.reauthActive ? (
        <ShellReauth busy={props.reauthBusy} />
      ) : props.updatePrompt || props.updateBusy ? (
        <ShellUpdate prompt={props.updatePrompt} busy={props.updateBusy} />
      ) : approvalActive ? (
        <ShellApproval request={props.pendingApproval} bypassConfirmation={props.bypassConfirmation} />
      ) : null}
      {props.paletteItems.length > 0 ? (
        <CommandPalette items={props.paletteItems} selectedIndex={props.paletteIndex} width={layout.transcriptWidth} />
      ) : null}
      <ShellComposer
        input={props.input}
        isRunning={props.isRunning}
        ultramaxxRun={props.ultramaxxRun}
        approvalActive={approvalActive}
        workState={props.workState}
        status={props.status}
        draftTokens={props.draftTokens}
        width={layout.transcriptWidth}
        onAttach={props.onAttach}
        onChange={props.onChange}
        onSubmit={props.onSubmit}
      />
      <ShellFooter agentMode={props.agentMode} paletteOpen={props.paletteItems.length > 0} />
    </Box>
  );
}

function ShellUpdate(props: {
  prompt: ExperimentalShellProps["updatePrompt"];
  busy: boolean;
}): React.ReactElement {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!props.busy) {
      setFrame(0);
      return;
    }

    const timer = setInterval(() => {
      setFrame((current) => current + 1);
    }, spinnerFrameMs);

    return () => {
      clearInterval(timer);
    };
  }, [props.busy]);

  const latestVersion = props.prompt?.latestVersion ?? "";
  const command = props.prompt?.command ?? "npm update -g @jx-grxf/patchpilot";
  return (
    <Box borderStyle="double" borderColor="yellow" flexDirection="column" paddingX={1}>
      <Text color="yellow" bold>
        {symbols.approval} PATCHPILOT UPDATE AVAILABLE
      </Text>
      {props.busy ? (
        <>
          <Text color="cyan">
            <Text bold>{spinnerGlyph(frame)}</Text> Updating PatchPilot…
          </Text>
          <Text color="gray">{command}</Text>
        </>
      ) : (
        <>
          <Text color="white">Install PatchPilot {latestVersion} now?</Text>
          <Text color="gray">
            Current {props.prompt?.currentVersion ?? "-"} · source {props.prompt?.source ?? "npm"} · {command}
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

function ShellHeader(props: ExperimentalShellProps): React.ReactElement {
  const accent = workStateColor(props.workState);
  const hostLabel = props.provider === "ollama" ? props.activeHost?.host.deviceName ?? "ollama" : `${props.provider} api`;
  const modeColor = props.agentMode === "bypass" ? "red" : props.agentMode === "build" ? "yellow" : "green";
  const modeLabel = props.agentMode === "bypass" ? "build+bypass" : props.agentMode;
  const writeLabel = props.allowWrite ? "on" : props.agentMode === "build" ? "approval" : "off";
  const shellLabel = props.allowShell ? "on" : props.agentMode === "build" ? "approval" : "off";
  // Gemini-Wrapper rides the free Gemini Web route; show what the same tokens
  // would have cost on the paid Gemini API — i.e. the running saved amount.
  const savedUsd =
    props.provider === "gemini-wrapper"
      ? estimateGeminiCost(props.sessionTelemetry.promptTokens, props.sessionTelemetry.responseTokens, props.model)
      : null;

  return (
    <Box borderStyle="round" borderColor={accent} flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text wrap="truncate">
          <Text color="cyan" bold>
            {symbols.assistant} PatchPilot
          </Text>
          <Text color="gray"> · </Text>
          <Text color="white">{props.provider}/{shortenMiddle(props.model, 24)}</Text>
          <Text color="gray"> on </Text>
          <Text color="white">{shortenMiddle(hostLabel, 16)}</Text>
        </Text>
        <Text wrap="truncate">
          {savedUsd !== null ? (
            <Text>
              <Text color="green" bold>
                saved {formatSavedCost(savedUsd)}
              </Text>
              <Text color="gray"> · </Text>
            </Text>
          ) : null}
          <Text color="gray">mode </Text>
          <Text color={modeColor} bold>
            {modeLabel}
          </Text>
        </Text>
      </Box>
      <Box justifyContent="space-between">
        <Text color="gray" wrap="truncate">
          {symbols.bullet} {shortenMiddle(props.workspace, 34)}
          <Text color="gray">  write </Text>
          <Text color={props.allowWrite ? "red" : "gray"}>{writeLabel}</Text>
          <Text color="gray">  shell </Text>
          <Text color={props.allowShell ? "red" : "gray"}>{shellLabel}</Text>
        </Text>
        <Text color="gray" wrap="truncate">
          {formatSessionTokens(props.sessionTelemetry)} · {formatCost(props.sessionTelemetry.estimatedCostUsd)}
        </Text>
      </Box>
    </Box>
  );
}

/** Compact bar listing attached documents and files PatchPilot created. */
function ArtifactsBar(props: { artifacts: Artifact[]; width: number }): React.ReactElement {
  const visible = props.artifacts.slice(-10);
  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1} overflowY="hidden">
      {/* One width-bounded row: a single truncating <Text> keeps the chip list
          from wrapping into extra rows and breaking the reserved height. */}
      <Text wrap="truncate">
        <Text color="gray">{symbols.assistant} artifacts </Text>
        {visible.map((artifact, index) => (
          <Text key={artifact.id}>
            {index > 0 ? <Text color="gray">   </Text> : null}
            <Text color={artifact.origin === "created" ? "green" : "cyan"}>
              {attachmentSymbol(artifact.kind)} {artifact.label}
            </Text>
            <Text color="gray">{artifact.origin === "created" ? " (new)" : ""}</Text>
          </Text>
        ))}
      </Text>
    </Box>
  );
}

function ShellTranscript(props: {
  lines: LogLine[];
  isRunning: boolean;
  ultramaxxRun: boolean;
  scrollOffset: number;
  height: number;
  width: number;
}): React.ReactElement {
  const rows = buildShellRows(props.lines, props.width);
  const [frame, setFrame] = useState(0);
  const hasRainbowRows = rows.some((row) => row.effect === "rainbow");
  useEffect(() => {
    if (!hasRainbowRows) {
      setFrame(0);
      return;
    }

    const timer = setInterval(() => {
      setFrame((current) => current + 1);
    }, waveFrameMs);

    return () => {
      clearInterval(timer);
    };
  }, [hasRainbowRows]);

  const preferredBannerHeight = props.width >= 88 && props.height >= 20 ? 12 : 3;
  const bannerHeight = Math.max(0, Math.min(props.height - 2, preferredBannerHeight));
  const viewport = Math.max(1, props.height - 2);
  // The banner is part of the scrollable content — it sits above the first
  // transcript row and scrolls away like any other chat message.
  const total = bannerHeight + rows.length;
  const overflow = total > viewport;
  // Reserve one row for the scroll indicator when content overflows.
  const contentViewport = Math.max(1, overflow ? viewport - 1 : viewport);
  const window = windowRows(total, contentViewport, props.scrollOffset);
  // Slice the banner and the text rows out of the shared window.
  const bannerVisibleStart = Math.min(window.start, bannerHeight);
  const bannerVisibleEnd = Math.min(window.end, bannerHeight);
  const bannerVisible = Math.max(0, bannerVisibleEnd - bannerVisibleStart);
  const rowStart = Math.max(0, window.start - bannerHeight);
  const rowEnd = Math.max(0, window.end - bannerHeight);
  const visibleRows = rows.slice(rowStart, rowEnd);
  const borderColor = props.ultramaxxRun ? "magenta" : props.isRunning ? "yellow" : "cyan";

  return (
    <Box borderStyle="round" borderColor={borderColor} flexDirection="column" paddingX={1} height={props.height} overflowY="hidden">
      {/* Content fills the scroll region: overflowing content fills it
          completely, short output anchors to the top. */}
      <Box flexDirection="column" flexGrow={1} overflowY="hidden">
        {bannerVisible > 0 ? (
          <Box height={bannerVisible} flexShrink={0} overflowY="hidden">
            <Box flexDirection="column" marginTop={-bannerVisibleStart}>
              <ExperimentalBanner width={props.width} height={bannerHeight} />
            </Box>
          </Box>
        ) : null}
        {visibleRows.map((row, index) => <ShellRowView key={`row-${index}`} row={row} frame={frame} />)}
      </Box>
      {window.hasOverflow ? (
        <Text color="gray">
          {symbols.todoActive}{" "}
          {rowEnd > rowStart ? `${rowStart + 1}–${rowEnd}` : "banner"}/{rows.length} · ↑↓ pgup/pgdn scroll
        </Text>
      ) : null}
    </Box>
  );
}

function ShellRowView(props: { row: ReturnType<typeof buildShellRows>[number]; frame: number }): React.ReactElement {
  const symbolColor = props.row.symbolColor ?? props.row.color;
  const labelColor = props.row.labelColor ?? props.row.color;
  const textColor = props.row.textColor ?? props.row.color;
  return (
    <Box>
      <Box width={2}>
        {props.row.effect === "rainbow" && props.row.symbol ? (
          <RainbowText text={props.row.symbol} frame={props.frame} bold={props.row.bold} />
        ) : (
          <Text color={symbolColor} dimColor={props.row.dim}>
            {props.row.symbol}
          </Text>
        )}
      </Box>
      <Box width={12} marginRight={1}>
        {props.row.effect === "rainbow" && props.row.label ? (
          <RainbowText text={props.row.label} frame={props.frame} bold={props.row.bold} />
        ) : (
          <Text color={labelColor} bold={props.row.bold} dimColor={props.row.dim} wrap="truncate">
            {props.row.label}
          </Text>
        )}
      </Box>
      <Text color={textColor} dimColor={props.row.dim} wrap="truncate">
        {props.row.text}
      </Text>
    </Box>
  );
}

function ShellTodoDock(props: {
  todos: AgentTodoItem[];
  todoFrame: number;
  height: number;
  width: number;
}): React.ReactElement {
  const rows = buildTodoDock(props.todos, props.width, props.todoFrame);
  const completed = props.todos.filter((todo) => todo.status === "completed").length;
  const total = Math.max(1, props.todos.length);
  const barWidth = 14;
  const filled = Math.round((completed / total) * barWidth);
  const bar = `${"▓".repeat(filled)}${"░".repeat(Math.max(0, barWidth - filled))}`;

  return (
    <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1} height={props.height} overflowY="hidden">
      <Box>
        <Text color="cyan" bold>
          {symbols.bullet} todos{" "}
        </Text>
        <Text color={completed === props.todos.length ? "green" : "yellow"}>{bar}</Text>
        <Text color="gray">
          {" "}
          {completed}/{props.todos.length}
        </Text>
      </Box>
      {rows.slice(1).map((row, index) => (
        <ShellRowView key={`todo-${index}`} row={row} frame={props.todoFrame} />
      ))}
    </Box>
  );
}

function ShellApproval(props: { request: ApprovalRequest | null; bypassConfirmation: boolean }): React.ReactElement {
  if (props.bypassConfirmation) {
    return (
      <Box borderStyle="double" borderColor="red" flexDirection="column" paddingX={1}>
        <Text color="red" bold>
          {symbols.approval} ACTION REQUIRED · trusted bypass
        </Text>
        <Text color="white">Write and shell tools will run without per-tool prompts for this session.</Text>
        <Text color="gray">Path guards and destructive-shell guards still apply.</Text>
        <Text>
          <Text color="green" bold>
            [y]
          </Text>
          <Text color="gray"> accept bypass   </Text>
          <Text color="red" bold>
            [n / esc]
          </Text>
          <Text color="gray"> stay build   </Text>
          <Text color="cyan" bold>
            [tab]
          </Text>
          <Text color="gray"> back to plan</Text>
        </Text>
      </Box>
    );
  }

  const request = props.request;
  if (!request) {
    return <Box />;
  }

  const target = approvalTarget(request.arguments);
  return (
    <Box borderStyle="double" borderColor="yellow" flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text color="yellow" bold>
          {symbols.approval} APPROVAL · {request.tool}
        </Text>
        <Text color="gray">
          needs {request.permission} · risk {request.risk}
        </Text>
      </Box>
      <Text color="white" wrap="truncate">
        {symbols.arrow} {request.preview}
      </Text>
      {target ? (
        <Box paddingX={1}>
          <Text color="gray">{target.kind === "command" || target.kind === "script" ? "$ " : ""}</Text>
          <Text color="cyan" wrap="truncate">
            {target.value}
          </Text>
        </Box>
      ) : null}
      <Text>
        <Text color="green" bold>
          [y]
        </Text>
        <Text color="gray"> allow once   </Text>
        <Text color="yellow" bold>
          [a]
        </Text>
        <Text color="gray"> allow session   </Text>
        <Text color="red" bold>
          [n / esc]
        </Text>
        <Text color="gray"> deny</Text>
      </Text>
    </Box>
  );
}

function ShellReauth(props: { busy: boolean }): React.ReactElement {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!props.busy) {
      setFrame(0);
      return;
    }

    const timer = setInterval(() => {
      setFrame((current) => current + 1);
    }, spinnerFrameMs);

    return () => {
      clearInterval(timer);
    };
  }, [props.busy]);

  return (
    <Box borderStyle="double" borderColor="yellow" flexDirection="column" paddingX={1}>
      <Text color="yellow" bold>
        {symbols.approval} GEMINI COOKIES EXPIRED
      </Text>
      {props.busy ? (
        <>
          <Text color="cyan">
            <Text bold>{spinnerGlyph(frame)}</Text> Refreshing Gemini browser cookies…
          </Text>
          <Text color="gray">Importing from your signed-in browser. The prompt retries automatically on success.</Text>
        </>
      ) : (
        <>
          <Text color="white">Refresh the Gemini browser cookies and retry your last prompt automatically?</Text>
          <Text color="gray">PatchPilot re-imports cookies from your signed-in browser. Secret values are not printed.</Text>
          <Text>
            <Text color="green" bold>
              [y]
            </Text>
            <Text color="gray"> refresh & retry   </Text>
            <Text color="red" bold>
              [n / esc]
            </Text>
            <Text color="gray"> dismiss</Text>
          </Text>
        </>
      )}
    </Box>
  );
}

function ShellComposer(props: {
  input: string;
  isRunning: boolean;
  ultramaxxRun: boolean;
  approvalActive: boolean;
  workState: AgentWorkState;
  status: string;
  draftTokens: number;
  width: number;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onAttach: (path: string) => string;
}): React.ReactElement {
  const [frame, setFrame] = useState(0);
  const [runningSince, setRunningSince] = useState<number | null>(null);
  const [cursor, setCursor] = useState(props.input.length);
  const layout = computeComposerLayout({
    input: props.input,
    width: props.width,
    promptWidth: 2,
    minHeight: 3,
    maxHeight: 7,
  });

  // Animate while running, and also while the draft contains the ultramaxx
  // keyword so its rainbow flows as you type.
  const animating = props.isRunning || hasUltramaxx(props.input);
  useEffect(() => {
    if (!props.isRunning) {
      setRunningSince(null);
    } else {
      setRunningSince((current) => current ?? Date.now());
    }

    if (!animating) {
      setFrame(0);
      return;
    }

    const timer = setInterval(() => {
      setFrame((current) => current + 1);
    }, waveFrameMs);

    return () => {
      clearInterval(timer);
    };
  }, [props.isRunning, animating]);

  // Keep the cursor valid when the draft is replaced from outside (submit,
  // slash-command fill, /clear).
  useEffect(() => {
    setCursor((current) => Math.min(current, props.input.length));
  }, [props.input]);

  const typingActive = !props.isRunning && !props.approvalActive;
  useInput(
    (value, key) => {
      if (!typingActive) {
        return;
      }

      const safeCursor = Math.max(0, Math.min(cursor, props.input.length));

      if (key.return) {
        if (key.shift || key.meta || key.super) {
          props.onChange(`${props.input.slice(0, safeCursor)}\n${props.input.slice(safeCursor)}`);
          setCursor(safeCursor + 1);
          return;
        }

        props.onSubmit(props.input);
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

      if (key.backspace || key.delete) {
        if (safeCursor > 0) {
          props.onChange(`${props.input.slice(0, safeCursor - 1)}${props.input.slice(safeCursor)}`);
          setCursor(safeCursor - 1);
        }
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
        props.onChange(`${props.input.slice(0, safeCursor)}${chip}${props.input.slice(safeCursor)}`);
        setCursor(safeCursor + chip.length);
        return;
      }

      props.onChange(`${props.input.slice(0, safeCursor)}${pasted}${props.input.slice(safeCursor)}`);
      setCursor(safeCursor + pasted.length);
    },
    { isActive: typingActive },
  );

  const elapsedMs = runningSince ? Date.now() - runningSince : 0;
  const accent = props.isRunning ? (props.ultramaxxRun ? "magenta" : "yellow") : props.approvalActive ? "yellow" : "cyan";
  const parts = runStatusParts({ workState: props.workState, status: props.status, elapsedMs });
  const safeCursor = Math.max(0, Math.min(cursor, props.input.length));
  const editorRows = layout.editorRows;
  const view = composerView(props.input, safeCursor, layout.inputWidth, editorRows);
  const showPlaceholder = props.input.length === 0;

  // The editor area always renders exactly `editorRows` rows so the composer's
  // real height matches the reserved layout height — no dead space anywhere.
  const editorContent: React.ReactNode[] = [];
  for (let index = 0; index < editorRows; index += 1) {
    if (props.isRunning && index === 0) {
      editorContent.push(
        <Box key="editor-run">
          {props.ultramaxxRun ? <RainbowText text={`${pulseGlyph(frame)} `} frame={frame} bold /> : (
            <Text color="cyan" bold>
              {pulseGlyph(frame)}{" "}
            </Text>
          )}
          {props.ultramaxxRun ? (
            <RainbowText text={parts.verb} frame={frame} bold />
          ) : (
            <WaveText text={parts.verb} frame={frame} bold />
          )}
          <Text color="gray">
            {"  ·  "}
            {parts.state}
            {parts.detail ? ` · ${parts.detail}` : ""}
          </Text>
          <Text color="gray">  {formatElapsed(elapsedMs)}</Text>
        </Box>,
      );
    } else if (!props.isRunning && props.approvalActive && index === 0) {
      editorContent.push(
        <Box key="editor-approval">
          <Text color="yellow" bold>
            {symbols.approval} approval waiting
          </Text>
          <Text color="gray"> — respond above before typing</Text>
        </Box>,
      );
    } else if (!props.isRunning && !props.approvalActive && showPlaceholder && index === 0) {
      editorContent.push(
        <Box key="editor-placeholder">
          <Box width={2}>
            <Text color="cyan" bold>
              {symbols.user}
            </Text>
          </Box>
          <Text inverse> </Text>
          <Text color="gray"> Ask PatchPilot, or press / for commands…</Text>
        </Box>,
      );
    } else if (!props.isRunning && !props.approvalActive && !showPlaceholder && index < view.rows.length) {
      const row = view.rows[index] ?? "";
      editorContent.push(
        <Box key={`editor-${index}`}>
          <Box width={2}>
            <Text color="cyan" bold>
              {index === 0 && view.hiddenAbove === 0 ? symbols.user : " "}
            </Text>
          </Box>
          {index === view.cursorRow ? (
            <ComposerCursorRow text={row} cursorCol={view.cursorCol} frame={frame} />
          ) : (
            <Text>
              {splitUltramaxxSegments(row).map((segment, segmentIndex) =>
                segment.ultramaxx ? (
                  <RainbowText key={`seg-${segmentIndex}`} text={segment.text} frame={index + segmentIndex} bold />
                ) : (
                  <Text key={`seg-${segmentIndex}`} color="white">
                    {segment.text}
                  </Text>
                ),
              )}
            </Text>
          )}
        </Box>,
      );
    } else {
      editorContent.push(<Box key={`editor-pad-${index}`} height={1} />);
    }
  }

  return (
    <Box borderStyle="round" borderColor={accent} flexDirection="column" paddingX={1} height={layout.height + 2} overflowY="hidden">
      <Box flexDirection="column" height={editorRows} overflowY="hidden">
        {editorContent}
      </Box>
      <Text color="gray" wrap="truncate">
        {props.isRunning
          ? props.ultramaxxRun
            ? "ULTRAMAXX run — escalated reasoning & step budget · esc stops the run."
            : "Run active — type /commands only, esc stops the run."
          : props.approvalActive
            ? "Approval pending — y once · a session · n deny."
            : `${props.draftTokens} tok draft${view.hiddenAbove > 0 ? ` · ${view.hiddenAbove} line${view.hiddenAbove === 1 ? "" : "s"} above` : ""} · ←→ move · ⏎ send · shift+⏎ newline · type ultramaxx to go hard`}
      </Text>
    </Box>
  );
}

/** Render a composer text part, rainbow-animated when it is the ultramaxx keyword. */
function ComposerPart(props: { text: string; ultramaxx: boolean; frame: number }): React.ReactElement {
  if (props.ultramaxx) {
    return <RainbowText text={props.text} frame={props.frame} bold />;
  }

  return <Text color="white">{props.text}</Text>;
}

/**
 * Render one composer row with the block cursor at the given column, keeping
 * the `ultramaxx` keyword rainbow-coloured around the caret.
 */
function ComposerCursorRow(props: { text: string; cursorCol: number; frame: number }): React.ReactElement {
  const col = Math.max(0, Math.min(props.cursorCol, props.text.length));
  const segments = splitUltramaxxSegments(props.text);
  const nodes: React.ReactNode[] = [];
  let pos = 0;
  let key = 0;
  for (const segment of segments) {
    const start = pos;
    const end = pos + segment.text.length;
    if (segment.text.length > 0 && col >= start && col < end) {
      const local = col - start;
      const before = segment.text.slice(0, local);
      const at = segment.text.slice(local, local + 1) || " ";
      const after = segment.text.slice(local + 1);
      if (before) {
        nodes.push(<ComposerPart key={`p-${key++}`} text={before} ultramaxx={segment.ultramaxx} frame={props.frame} />);
      }
      nodes.push(
        <Text key={`p-${key++}`} inverse>
          {at}
        </Text>,
      );
      if (after) {
        nodes.push(<ComposerPart key={`p-${key++}`} text={after} ultramaxx={segment.ultramaxx} frame={props.frame} />);
      }
    } else if (segment.text.length > 0) {
      nodes.push(<ComposerPart key={`p-${key++}`} text={segment.text} ultramaxx={segment.ultramaxx} frame={props.frame} />);
    }
    pos = end;
  }
  if (col >= props.text.length) {
    nodes.push(
      <Text key={`p-${key++}`} inverse>
        {" "}
      </Text>,
    );
  }
  return <Text>{nodes}</Text>;
}

function ShellFooter(props: { agentMode: AgentMode; paletteOpen: boolean }): React.ReactElement {
  return (
    <Box paddingX={1}>
      <Text color="gray" wrap="truncate">
        <Text color="cyan">tab</Text> plan/build/bypass <Text color="gray">·</Text>{" "}
        <Text color="cyan">/</Text> palette <Text color="gray">·</Text>{" "}
        <Text color="cyan">↑↓</Text> {props.paletteOpen ? "pick" : "scroll"} <Text color="gray">·</Text>{" "}
        <Text color="cyan">esc</Text> {props.paletteOpen ? "close" : "step stop / double force"} <Text color="gray">·</Text>{" "}
        <Text color="gray">mode {props.agentMode}</Text>
      </Text>
    </Box>
  );
}

function approvalTarget(args: Record<string, unknown>): { kind: string; value: string } | null {
  if (typeof args.path === "string" && args.path) {
    return { kind: "path", value: truncate(args.path, 64) };
  }

  if (typeof args.script === "string" && args.script) {
    return { kind: "script", value: truncate(args.script, 64) };
  }

  if (typeof args.command === "string" && args.command) {
    return { kind: "command", value: truncate(args.command, 64) };
  }

  return null;
}
