import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { AgentTodoItem, AgentWorkState, ApprovalRequest, ModelProvider, ModelTelemetry, SessionTelemetry } from "../../core/types.js";
import type { CommandSuggestionItem } from "../components/CommandSuggestions.js";
import { formatCost, formatSessionTokens, shortenMiddle } from "../format.js";
import type { OllamaHostDetails } from "../hosts.js";
import { computeComposerLayout } from "../layout.js";
import { formatElapsed, pulseGlyph, runStatusParts, spinnerGlyph, waveFrameMs } from "../runStatus.js";
import type { AgentMode, LogLine } from "../types.js";
import { RainbowText, WaveText } from "./AnimatedText.js";
import { ExperimentalBanner } from "./Banner.js";
import { CommandPalette } from "./CommandPalette.js";
import { computeExperimentalLayout, windowRows } from "./layout.js";
import { symbols, workStateColor } from "./theme.js";
import { buildShellRows, buildTodoDock, truncate } from "./transcriptRows.js";
import { splitUltramaxxSegments } from "./ultramaxx.js";

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
  transcriptScrollOffset: number;
  input: string;
  paletteItems: CommandSuggestionItem[];
  paletteIndex: number;
  rows: number;
  columns: number;
  activeHost: OllamaHostDetails | null;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
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
  const approvalActive = Boolean(props.pendingApproval || props.bypassConfirmation);
  const layout = computeExperimentalLayout({
    rows: props.rows,
    columns: props.columns,
    composerInput: props.input,
    paletteItemCount: props.paletteItems.length,
    approvalActive,
    todoCount: props.todos.length,
  });

  return (
    <Box flexDirection="column" height={layout.rootHeight} overflowY="hidden">
      <ShellHeader {...props} />
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
      {approvalActive ? (
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
        onChange={props.onChange}
        onSubmit={props.onSubmit}
      />
      <ShellFooter agentMode={props.agentMode} paletteOpen={props.paletteItems.length > 0} />
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

function ShellTranscript(props: {
  lines: LogLine[];
  isRunning: boolean;
  ultramaxxRun: boolean;
  scrollOffset: number;
  height: number;
  width: number;
}): React.ReactElement {
  const rows = buildShellRows(props.lines, props.width);
  const viewport = Math.max(1, props.height - 2);
  const overflow = rows.length > viewport;
  // Reserve one row for the scroll indicator when content overflows.
  const contentViewport = Math.max(1, overflow ? viewport - 1 : viewport);
  const window = windowRows(rows.length, contentViewport, props.scrollOffset);
  const visibleRows = rows.slice(window.start, window.end);
  const showBanner = props.lines.length === 0;
  const borderColor = props.ultramaxxRun ? "magenta" : props.isRunning ? "yellow" : "cyan";

  return (
    <Box borderStyle="round" borderColor={borderColor} flexDirection="column" paddingX={1} height={props.height} overflowY="hidden">
      {/* Content fills the scroll region: overflowing content fills it
          completely, short output anchors to the top. */}
      <Box flexDirection="column" flexGrow={1} overflowY="hidden">
        {showBanner ? (
          <ExperimentalBanner width={props.width} height={props.height} />
        ) : (
          visibleRows.map((row, index) => <ShellRowView key={`row-${index}`} row={row} />)
        )}
      </Box>
      {window.hasOverflow ? (
        <Text color="gray">
          {symbols.todoActive} {window.start + 1}–{window.end}/{rows.length} · ↑↓ pgup/pgdn scroll
        </Text>
      ) : null}
    </Box>
  );
}

function ShellRowView(props: { row: ReturnType<typeof buildShellRows>[number] }): React.ReactElement {
  return (
    <Box>
      <Box width={2}>
        <Text color={props.row.color} dimColor={props.row.dim}>
          {props.row.symbol}
        </Text>
      </Box>
      <Box width={12} marginRight={1}>
        <Text color={props.row.color} bold={props.row.bold} dimColor={props.row.dim} wrap="truncate">
          {props.row.label}
        </Text>
      </Box>
      <Text color={props.row.color} dimColor={props.row.dim} wrap="truncate">
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
        <ShellRowView key={`todo-${index}`} row={row} />
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
}): React.ReactElement {
  const [frame, setFrame] = useState(0);
  const [runningSince, setRunningSince] = useState<number | null>(null);
  const layout = computeComposerLayout({
    input: props.input,
    width: props.width,
    promptWidth: 2,
    minHeight: 3,
    maxHeight: 7,
  });

  useEffect(() => {
    if (!props.isRunning) {
      setRunningSince(null);
      setFrame(0);
      return;
    }

    setRunningSince((current) => current ?? Date.now());
    const timer = setInterval(() => {
      setFrame((current) => current + 1);
    }, waveFrameMs);

    return () => {
      clearInterval(timer);
    };
  }, [props.isRunning]);

  const typingActive = !props.isRunning && !props.approvalActive;
  useInput(
    (value, key) => {
      if (!typingActive) {
        return;
      }

      if (key.return) {
        if (key.shift || key.meta || key.super) {
          props.onChange(`${props.input}\n`);
          return;
        }

        props.onSubmit(props.input);
        return;
      }

      if (key.backspace || key.delete) {
        // Code-point-safe delete so emoji / CJK are not corrupted.
        props.onChange([...props.input].slice(0, -1).join(""));
        return;
      }

      if (
        key.tab ||
        key.escape ||
        key.upArrow ||
        key.downArrow ||
        key.leftArrow ||
        key.rightArrow ||
        key.pageUp ||
        key.pageDown ||
        key.home ||
        key.end ||
        key.ctrl ||
        value.length === 0
      ) {
        return;
      }

      props.onChange(`${props.input}${value}`);
    },
    { isActive: typingActive },
  );

  const elapsedMs = runningSince ? Date.now() - runningSince : 0;
  const accent = props.isRunning ? (props.ultramaxxRun ? "magenta" : "yellow") : props.approvalActive ? "yellow" : "cyan";
  const placeholder = props.input.length === 0 ? "Ask PatchPilot, or press / for commands…" : "";
  const parts = runStatusParts({ workState: props.workState, status: props.status, elapsedMs });

  return (
    <Box borderStyle="round" borderColor={accent} flexDirection="column" paddingX={1}>
      {props.isRunning ? (
        <Box>
          <Text color={props.ultramaxxRun ? "magenta" : "cyan"} bold>
            {pulseGlyph(frame)}{" "}
          </Text>
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
        </Box>
      ) : props.approvalActive ? (
        <Box>
          <Text color="yellow" bold>
            {symbols.approval} approval waiting
          </Text>
          <Text color="gray"> — respond above before typing</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          {layout.visibleRows.map((row, index) => {
            const isLast = index === layout.visibleRows.length - 1;
            const showPlaceholder = Boolean(placeholder) && isLast && row.length === 0;
            return (
              <Box key={`composer-${index}`}>
                <Box width={2}>
                  <Text color="cyan" bold>
                    {index === 0 ? symbols.user : " "}
                  </Text>
                </Box>
                <Text>
                  {showPlaceholder ? (
                    <Text color="gray">{placeholder}</Text>
                  ) : (
                    splitUltramaxxSegments(row).map((segment, segmentIndex) =>
                      segment.ultramaxx ? (
                        <RainbowText key={`seg-${segmentIndex}`} text={segment.text} frame={index + segmentIndex} bold />
                      ) : (
                        <Text key={`seg-${segmentIndex}`} color="white">
                          {segment.text}
                        </Text>
                      ),
                    )
                  )}
                  {isLast ? <Text color="cyan">{symbols.caret}</Text> : null}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}
      <Text color="gray" wrap="truncate">
        {props.isRunning
          ? props.ultramaxxRun
            ? "ULTRAMAXX run — escalated reasoning & step budget · esc stops the run."
            : "Run active — type /commands only, esc stops the run."
          : props.approvalActive
            ? "Approval pending — y once · a session · n deny."
            : `${props.draftTokens} tok draft${layout.hiddenRows > 0 ? ` · ${layout.hiddenRows} line${layout.hiddenRows === 1 ? "" : "s"} above` : ""} · ⏎ send · shift+⏎ newline · type ultramaxx to go hard`}
      </Text>
    </Box>
  );
}

function ShellFooter(props: { agentMode: AgentMode; paletteOpen: boolean }): React.ReactElement {
  return (
    <Box paddingX={1}>
      <Text color="gray" wrap="truncate">
        <Text color="cyan">tab</Text> plan/build/bypass <Text color="gray">·</Text>{" "}
        <Text color="cyan">/</Text> palette <Text color="gray">·</Text>{" "}
        <Text color="cyan">↑↓</Text> {props.paletteOpen ? "pick" : "scroll"} <Text color="gray">·</Text>{" "}
        <Text color="cyan">esc</Text> {props.paletteOpen ? "close" : "stop"} <Text color="gray">·</Text>{" "}
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
