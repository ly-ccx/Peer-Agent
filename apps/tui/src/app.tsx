import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { TextareaRenderable } from '@opentui/core';
import { useKeyboard, useRenderer, useSelectionHandler, useTerminalDimensions } from '@opentui/react';
import type { LocalAccessLevel } from '@peer-agent/protocol';
import type { RuntimeModelSelection } from '@peer-agent/runtime-node';

import { B3Wordmark } from './b3-wordmark-view.tsx';
import { ThemedText, ThemedTextarea } from './themed-primitives.tsx';
import { MarkdownView } from './markdown-view.tsx';
import { copyTextToClipboard, selectionCopyNotice } from './tui-clipboard.ts';
import { buildTuiHelpSections, resolveTuiCommandInput } from './command-registry.ts';
import { executeTuiCommand } from './command-execution.ts';
import { resolveLeaderKey } from './leader-key.ts';
import {
  createConversationRenderWindowState,
  navigateConversationHistory,
  projectConversationRenderWindow,
  type ConversationRenderWindow,
  type ConversationRenderWindowState,
} from './conversation-render-window.ts';
import type { TuiMcpServerSummary, TuiSkillSummary } from './skill-mcp-bridge.ts';
import {
  createTuiConversationPersistence,
  resumeTuiConversation,
  type TuiConversationSummary,
} from './conversation-persistence.ts';
import {
  ComposerModeDivider,
  ComposerRunningStatusBar,
  ComposerStatusBar,
  type ComposerStatusLayout,
} from './composer-status-view.tsx';
import { composerLayoutModel } from './composer-layout-model.ts';
import { compactWorkspacePath, createComposerStatus, type ComposerStatus } from './composer-status.ts';
import {
  createChatController,
  type ChatController,
  type ChatMessage,
  type ChatModelPort,
  type ChatSnapshot,
} from './chat-controller.ts';
import {
  chipifyImagePathsInText,
  extractImagePathTokens,
  formatUserMessageBody,
  mergeImagePasteWithExistingDraft,
  isSlashCommandInput,
  loadLocalImageAttachments,
  registerImagePathKeys,
} from './composer-image-paths.ts';
import {
  approvalCardDetails,
  approvalDecisionForKey,
  moveApprovalSelection,
  TUI_APPROVAL_OPTIONS,
} from './approval-card.ts';
import {
  extractUserInputRequest,
  toUserInputOptions,
  userInputDecisionForKey,
  type TuiUserInputRequest,
} from './user-input-card.ts';
import {
  createPlanCoordinator,
  movePlanSelection,
  PLAN_APPROVAL_OPTIONS,
  planDecisionForKey,
} from './plan-mode.ts';
import { createTuiSharedGoalRunner } from './goal-runner-adapter.ts';
import {
  displayableGoalPlans,
  filterGoalPlanHistory,
  selectActiveGoalPlanId,
  selectPreferredGoalPlanId,
  type TuiGoalPlan,
} from './goal-plan-history.ts';
import {
  goalStatusFromSharedPlan,
  goalStatusLayout,
} from './goal-status-model.ts';
import { GoalCompactSummary, GoalPlanPicker, GoalStatusPanel } from './goal-status-view.tsx';
import {
  buildModelPickerView,
  cycleModelPickerGroup,
  formatModelPickerGroupLabel,
  indexOfCurrentSelectableRow,
  modelPickerGroupCounts,
  modelSelectionLabel,
  sessionTopbarModelLabel,
  type ModelPickerStage,
  type ModelPickerViewRow,
  type TuiModelSelectionControl,
} from './tui-model-selection.ts';
import type { PendingApproval, TuiHost } from './tui-host.ts';
import { TUI_MODES, tuiModeOption, type TuiMode } from './tui-mode.ts';
import {
  composerPlaceholder,
  composerRunningStatusLabel,
  languageIndex,
  languageOption,
  TUI_LANGUAGE_OPTIONS,
  tuiMessage,
  type TuiLanguageStore,
  type TuiLocale,
} from './tui-language.ts';
import {
  permissionPolicyForKey,
  permissionPolicyIndex,
  TUI_PERMISSION_POLICIES,
} from './tui-permission-policy.ts';
import { moveTuiSurfaceSelection } from './surface-state.ts';
import { composerEnterAction, runtimeControlAction } from './runtime-controls.ts';
import { composerContentWidth, responsiveLayout, responsivePickerLayout } from './responsive-layout.ts';
import {
  animatedToolStatusGlyph,
  formatToolDuration,
  isGoalStatusToolPresentation,
  toolActivitySummary,
  resolveToolPresentation,
  runningActivityField,
  formatRunningElapsed,
  thinkingSpinnerGlyph,
  thinkingStatusLabel,
  toolHeadline,
  toolStatusGlyph,
  toggleToolDetails,
  type ToolPresentation,
  type ToolPresentationStatus,
} from './tool-result-summary.ts';
import {
  applyTuiCommand,
  createTuiExperienceState,
  escapeFooter,
  filterTuiCommands,
  openCommandPanel,
  openPicker,
  selectionWindow,
  showUserInput,
  slashCommandWindow,
  syncSlashSuggestions,
  type TuiCommand,
  type TuiExperienceState,
  updateCommandPanelQuery,
} from './tui-experience.ts';
import { ThinkingView } from './thinking-view.tsx';
import {
  APP_CHROME,
  COLOR,
  PICKER_CHROME,
  TOOL_CHROME,
  TUI_THEME_OPTIONS,
  toolStatusColor,
  type TuiThemeMode,
  type TuiThemeStore,
} from './tui-theme.ts';

const COMMAND_NOTICE_DURATION_MS = 3_000;
const THINKING_SPINNER_INTERVAL_MS = 120;


function useStatusAnimationFrame(active: boolean, intervalMs = 280): number {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) {
      setFrame(0);
      return;
    }
    const timer = setInterval(() => {
      setFrame((current) => current + 1);
    }, intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return frame;
}

function ThinkingStatusLabel({
  hasThinkingContent,
  thinkingText,
}: {
  readonly hasThinkingContent: boolean;
  readonly thinkingText?: string;
}) {
  const frame = useStatusAnimationFrame(true, THINKING_SPINNER_INTERVAL_MS);
  return (
    <ThinkingView
      content={thinkingText}
      label={thinkingStatusLabel(frame, hasThinkingContent)}
    />
  );
}


function ComposerRunningStatusLabel({
  locale,
  runStatus,
  width,
}: {
  readonly locale: TuiLocale;
  readonly runStatus: 'running' | 'cancelling' | 'compacting';
  readonly width: number;
}) {
  const frame = useStatusAnimationFrame(true, THINKING_SPINNER_INTERVAL_MS);
  const startedAtRef = useRef(Date.now());
  const activity = runningActivityField(frame, width);
  const elapsed = formatRunningElapsed(Date.now() - startedAtRef.current);
  const status = composerRunningStatusLabel(locale, runStatus);
  return (
    <ComposerRunningStatusBar
      activity={activity}
      statusLabel={width < 30 ? `· ${elapsed}` : `${status} · ${elapsed}`}
    />
  );
}

function ToolStatusGlyph({ status }: { readonly status: ToolPresentationStatus }) {
  const active = status === 'running';
  const frame = useStatusAnimationFrame(active);
  return <>{animatedToolStatusGlyph(status, frame)}</>;
}

function isEvidenceDetail(line: string): boolean {
  return /(?:evidence|artifact)(?:ref)?s?\b|(?:tool-result|local-shell-artifact|artifact):\/\//i.test(line);
}

function ToolActivityTimeline({
  presentation,
  expanded,
  onToggle,
}: {
  readonly presentation: ToolPresentation;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  const color = toolStatusColor(presentation.status);
  const detailLines = expanded
    ? presentation.detail.split(/\r?\n/).filter((line) => line.trim().length > 0)
    : [];
  const summary = toolActivitySummary(presentation);
  const canExpand = presentation.detail.trim().length > 0;
  // Status is already carried by the leading glyph + color; avoid a redundant
  // trailing word like "done" next to ✓.
  return (
    <box flexDirection="row">
      <box width={2} flexDirection="column" alignItems="center">
        <text fg={color}><ToolStatusGlyph status={presentation.status} /></text>
        {expanded && detailLines.length > 0 ? <text fg={COLOR.subtle}>┆</text> : null}
      </box>
      <box flexGrow={1} minWidth={0} flexDirection="column">
        <box flexDirection="row" width="100%">
          <ThemedText selectable fg={COLOR.textSoft} width={12} wrapMode="none">{presentation.toolName}</ThemedText>
          <ThemedText selectable fg={COLOR.muted} flexGrow={1} minWidth={0} wrapMode="none">{summary}</ThemedText>
          <ThemedText selectable fg={presentation.status === 'running' ? COLOR.accent : COLOR.subtle} width={7} marginLeft={2} flexShrink={0} wrapMode="none">
            {formatToolDuration(presentation)}
          </ThemedText>
          <text fg={canExpand ? COLOR.muted : COLOR.subtle} width={2} wrapMode="none" onMouseDown={canExpand ? onToggle : undefined}>
            {canExpand ? (expanded ? '−' : '+') : ' '}
          </text>
        </box>
        {detailLines.map((line, index) => {
          const evidence = isEvidenceDetail(line);
          return (
            <box key={`${presentation.toolCallId ?? presentation.toolName}-detail-${index}`} flexDirection="row">
              <text fg={COLOR.subtle}>┆ </text>
              {evidence ? <text fg={COLOR.success}>evidence </text> : null}
              <ThemedText selectable fg={evidence ? COLOR.textSoft : COLOR.toolDetail}>{line || ' '}</ThemedText>
            </box>
          );
        })}
      </box>
    </box>
  );
}

function ChatHistory({
  messages,
  window,
  layout,
}: {
  readonly messages: readonly ChatMessage[];
  readonly window: ConversationRenderWindow;
  readonly layout: ReturnType<typeof responsiveLayout>;
}) {
  const [expandedTools, setExpandedTools] = useState<ReadonlySet<string>>(new Set());
  const roleRailWidth = 7;
  const roleBodyGap = layout.density === 'compact' ? 2 : 1;

  const toggleTool = (messageId: string) => {
    setExpandedTools((current) => {
      const next = new Set(current);
      if (toggleToolDetails(next.has(messageId))) next.add(messageId);
      else next.delete(messageId);
      return next;
    });
  };

  return (
    <scrollbox
      flexGrow={1}
      flexShrink={1}
      minHeight={0}
      stickyScroll
      stickyStart="bottom"
      paddingLeft={layout.outerPadding}
      paddingRight={layout.outerPadding}
    >
      {window.hiddenBefore > 0 ? (
        <box flexDirection="column" marginBottom={1}>
          <ThemedText selectable fg={COLOR.muted}>
            {window.reason === 'latest-compaction' && !window.emergencyTruncated
              ? `↑ Showing from the latest compaction · ${window.hiddenBefore} earlier messages hidden · /history earlier`
              : `↑ ${window.hiddenBefore} earlier messages hidden · /history earlier`}
          </ThemedText>
          {window.emergencyTruncated ? (
            <ThemedText selectable fg={COLOR.warning}>
              Recent history was capped for terminal performance.
            </ThemedText>
          ) : null}
        </box>
      ) : null}
      {messages.map((message) => {
        if (message.role === 'system') {
          const phase = message.compact?.phase ?? 'done';
          const label = phase === 'progress' ? 'COMPACTING' : 'COMPACTED';
          const compactSummary = phase === 'done'
            ? `Earlier conversation (compacted) · ${message.compact?.summarizedCount ?? 0} msgs · Structural`
            : message.content;
          return (
            <box key={message.id} flexDirection="column" marginBottom={1} marginTop={1}>
              <box flexDirection="row">
                <text fg={COLOR.muted}>{'─'.repeat(8)} </text>
                <text fg={COLOR.accent}><strong>{label}</strong></text>
                <text fg={COLOR.muted}> {'─'.repeat(8)}</text>
              </box>
              <ThemedText selectable fg={COLOR.muted}>{compactSummary || ' '}</ThemedText>
            </box>
          );
        }

        if (message.role === 'assistant') {
          const segments = message.segments && message.segments.length > 0
            ? message.segments
            : null;
          const legacyTools = message.tools && message.tools.length > 0
            ? message.tools
            : (message.tool ? [message.tool] : []);
          const thinkingText = message.thinkingContent?.trim();
          const hasSegmentThinking = Boolean(
            segments?.some((segment) => segment.type === 'thinking' && segment.content.trim()),
          );
          const hasSegmentTools = Boolean(
            segments?.some((segment) => segment.type === 'tool-call'),
          );
          const hasSegmentText = Boolean(
            segments?.some((segment) => segment.type === 'text' && segment.content),
          );
          const showThinkingPlaceholder = message.pending
            && !message.content
            && !hasSegmentText
            && !hasSegmentTools
            && !hasSegmentThinking
            && !thinkingText
            && legacyTools.length === 0;

          const renderTool = (tool: (typeof legacyTools)[number], toolKey: string) => {
            const toolExpanded = expandedTools.has(toolKey);
            const presentation = resolveToolPresentation({ content: '', tool });
            if (isGoalStatusToolPresentation(presentation)) return null;
            return (
              <ToolActivityTimeline
                key={toolKey}
                presentation={presentation}
                expanded={toolExpanded}
                onToggle={() => toggleTool(toolKey)}
              />
            );
          };

          return (
            <box key={message.id} flexDirection="row" gap={roleBodyGap} marginBottom={1}>
              <box width={roleRailWidth}><text fg={COLOR.accent}><strong>PEER</strong></text></box>
              <box flexDirection="column" flexGrow={1} minWidth={0}>
                {showThinkingPlaceholder ? (
                  <ThinkingStatusLabel
                    hasThinkingContent={false}
                  />
                ) : null}
                {segments
                  ? segments.map((segment, segmentIndex) => {
                    if (segment.type === 'thinking') {
                      const text = segment.content.trim();
                      if (!text) return null;
                      // While streaming the open thinking tail, keep the animated label.
                      const isOpenThinking = message.pending
                        && segmentIndex === segments.length - 1;
                      if (isOpenThinking) {
                        return (
                          <ThinkingStatusLabel
                            key={`${message.id}-thinking-${segmentIndex}`}
                            hasThinkingContent
                            thinkingText={text}
                          />
                        );
                      }
                      return (
                        <ThinkingView
                          key={`${message.id}-thinking-${segmentIndex}`}
                          content={text}
                        />
                      );
                    }
                    if (segment.type === 'tool-call') {
                      const toolKey = `${message.id}-tool-${segment.tool.toolCallId ?? segmentIndex}`;
                      return renderTool(segment.tool, toolKey);
                    }
                    // text
                    if (!segment.content) return null;
                    return (
                      <MarkdownView
                        key={`${message.id}-text-${segmentIndex}`}
                        content={segment.content}
                      />
                    );
                  })
                  : (
                    <>
                      {thinkingText ? (
                        <ThinkingView content={thinkingText} />
                      ) : null}
                      {legacyTools.map((tool, toolIndex) => {
                        const toolKey = `${message.id}-tool-${tool.toolCallId ?? toolIndex}`;
                        return renderTool(tool, toolKey);
                      })}
                      {!showThinkingPlaceholder && message.content ? (
                        <MarkdownView content={message.content} />
                      ) : null}
                    </>
                  )}
              </box>
            </box>
          );
        }

        if (message.role === 'user') {
          // History must surface both typed text and image attachments.
          // Pure-image turns store empty content + images[]; without a chip they look "missing".
          const { text: userText, imageLabel } = formatUserMessageBody(
            message.content,
            message.images,
          );
          // Crush-style user turn: muted YOU rail + cyan bar on the body column.
          return (
            <box key={message.id} flexDirection="row" width="100%" gap={roleBodyGap} marginBottom={1}>
              <box width={roleRailWidth}><text fg={COLOR.muted}>YOU</text></box>
              <box flexDirection="row" flexGrow={1} minWidth={0}>
                <text fg={COLOR.user}>{APP_CHROME.userRailBar}</text>
                <box flexDirection="column" flexGrow={1} minWidth={0} paddingLeft={1}>
                  {userText ? <ThemedText selectable fg={COLOR.text}>{userText}</ThemedText> : null}
                  {imageLabel ? <ThemedText selectable fg={COLOR.user}>{imageLabel}</ThemedText> : null}
                  {!userText && !imageLabel ? <ThemedText selectable fg={COLOR.textSoft}>{' '}</ThemedText> : null}
                </box>
              </box>
            </box>
          );
        }

        const toolExpanded = expandedTools.has(message.id);
        const presentation = resolveToolPresentation(message);
        if (isGoalStatusToolPresentation(presentation)) return null;
        return (
          <box key={message.id} flexDirection="column">
            <ToolActivityTimeline
              presentation={presentation}
              expanded={toolExpanded}
              onToggle={() => toggleTool(message.id)}
            />
          </box>
        );
      })}
      {window.hiddenAfter > 0 ? (
        <box marginTop={1}>
          <ThemedText selectable fg={COLOR.muted}>
            {`↓ ${window.hiddenAfter} newer messages hidden · /history later · /history latest`}
          </ThemedText>
        </box>
      ) : null}
    </scrollbox>
  );
}

function ErrorBanner({
  message,
  layout,
}: {
  readonly message: string;
  readonly layout: ReturnType<typeof responsiveLayout>;
}) {
  return (
    <box flexShrink={0} paddingLeft={layout.outerPadding} paddingRight={layout.outerPadding}>
      <text fg={COLOR.dangerSoft} wrapMode="word">Error: {message}</text>
    </box>
  );
}

function SlashCommandMenu({ commands, selectedIndex, maxVisible, showDescriptions, bottom }: {
  readonly commands: readonly TuiCommand[];
  readonly selectedIndex: number;
  readonly maxVisible: number;
  readonly showDescriptions: boolean;
  readonly bottom: number;
}) {
  const visibleCommands = slashCommandWindow(commands, selectedIndex, maxVisible);

  return (
    <box
      position="absolute"
      left={0}
      right={0}
      bottom={bottom}
      zIndex={100}
      flexDirection="column"
      border={['top']}
      borderColor={PICKER_CHROME.border}
      backgroundColor={PICKER_CHROME.idleBackground}
    >
      {visibleCommands.length === 0 ? (
        <text fg={COLOR.muted}>No matching commands</text>
      ) : visibleCommands.map(({ command, index }) => {
        const selected = index === selectedIndex;
        return (
          <box
            key={command.id}
            flexDirection="row"
            height={1}
            justifyContent="space-between"
            backgroundColor={PICKER_CHROME.idleBackground}
          >
            <text fg={selected ? PICKER_CHROME.selectedForeground : PICKER_CHROME.idleForeground} wrapMode="none">
              {selected ? PICKER_CHROME.caretSelected : PICKER_CHROME.caretIdle}/{command.id}
            </text>
            {showDescriptions ? (
              <text fg={COLOR.muted} wrapMode="none">{command.description}</text>
            ) : null}
          </box>
        );
      })}
    </box>
  );
}

function ResumePickerMenu({ rows, selectedIndex, maxVisible, onResume }: {
  readonly rows: readonly TuiConversationSummary[];
  readonly selectedIndex: number;
  readonly maxVisible: number;
  readonly onResume: (row: TuiConversationSummary) => void;
}) {
  const visibleRows = selectionWindow(rows, selectedIndex, maxVisible);
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      border={['top']}
      borderColor={PICKER_CHROME.border}
      backgroundColor={PICKER_CHROME.idleBackground}
      marginLeft={1}
      marginRight={1}
      marginTop={1}
      marginBottom={1}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      paddingBottom={1}
    >
      <text fg={PICKER_CHROME.title} wrapMode="none"><strong>Resume session</strong></text>
      {rows.length === 0 ? <text fg={COLOR.muted}>No saved conversations to resume.</text> : visibleRows.map(({ item: row, index }) => {
        const selected = index === selectedIndex;
        return (
          <box
            key={row.id}
            flexDirection="row"
            height={1}
            backgroundColor={PICKER_CHROME.idleBackground}
            onMouseDown={() => onResume(row)}
          >
            <text fg={selected ? PICKER_CHROME.selectedForeground : PICKER_CHROME.idleForeground} wrapMode="none">
              {selected ? PICKER_CHROME.caretSelected : PICKER_CHROME.caretIdle}{row.title}  ({row.messageCount} messages)
            </text>
          </box>
        );
      })}
      <text fg={COLOR.muted} wrapMode="none">↑↓ choose · enter resume · esc close</text>
    </box>
  );
}

function ModelPickerMenu({
  title,
  subtitle,
  groups,
  activeGroup,
  query,
  rows,
  selectedIndex,
  maxVisible,
  showHint,
  bottom,
}: {
  readonly title: string;
  readonly subtitle?: string;
  readonly groups: readonly string[];
  readonly activeGroup: string | null;
  readonly query: string;
  readonly rows: readonly ModelPickerViewRow[];
  readonly selectedIndex: number;
  readonly maxVisible: number;
  readonly showHint: boolean;
  readonly bottom: number;
}) {
  // Map selectable-row index onto absolute row index so section headers stay visible.
  const selectableAbsoluteIndexes = rows
    .map((row, index) => (row.selectable ? index : -1))
    .filter((index) => index >= 0);
  const absoluteSelected = selectableAbsoluteIndexes[selectedIndex] ?? 0;
  const start = Math.max(0, Math.min(
    absoluteSelected - Math.floor(maxVisible / 2),
    Math.max(0, rows.length - maxVisible),
  ));
  const visibleRows = rows.slice(start, start + maxVisible);

  return (
    <box
      position="absolute"
      left={0}
      right={0}
      bottom={bottom}
      zIndex={100}
      flexDirection="column"
      border={['top']}
      borderColor={PICKER_CHROME.border}
      backgroundColor={PICKER_CHROME.idleBackground}
    >
      <text fg={PICKER_CHROME.title} wrapMode="none"><strong>{title}</strong>{subtitle ? ` · ${subtitle}` : ''}</text>
      {groups.length > 0 ? (
        // Wrap chips and highlight the active group more clearly than brackets alone.
        <text wrapMode="word">
          {groups.map((group, index) => {
            const raw = group.replace(/ \(\d+\/\d+\)$/, '');
            const active = raw === activeGroup;
            return (
              <span key={group} fg={active ? PICKER_CHROME.selectedForeground : PICKER_CHROME.mutedForeground}>
                {active ? <strong>[{group}]</strong> : group}
                {index < groups.length - 1 ? '  ' : ''}
              </span>
            );
          })}
        </text>
      ) : null}
      <text fg={COLOR.muted} wrapMode="none">Search: {query.length > 0 ? query : '…'}</text>
      {visibleRows.length === 0 ? (
        <text fg={PICKER_CHROME.warning} wrapMode="none">No configured model is available.</text>
      ) : visibleRows.map((row, offset) => {
        const absoluteIndex = start + offset;
        const selected = absoluteIndex === absoluteSelected;
        if (row.kind === 'section') {
          return (
            <text key={row.key} fg={COLOR.muted} wrapMode="none">
              {row.label}
            </text>
          );
        }
        const color = !row.selectable
          ? COLOR.muted
          : (selected ? PICKER_CHROME.selectedForeground : PICKER_CHROME.idleForeground);
        return (
          <box
            key={row.key}
            flexDirection="row"
            height={1}
            backgroundColor={selected && row.selectable ? PICKER_CHROME.selectedBackground : PICKER_CHROME.idleBackground}
          >
            <text fg={color} wrapMode="none">
              {selected && row.selectable ? PICKER_CHROME.caretSelected : PICKER_CHROME.caretIdle}
              {row.label}
              {row.detail ? `  ${row.detail}` : ''}
              {row.current ? PICKER_CHROME.checkCurrent : ''}
            </text>
          </box>
        );
      })}
      {showHint ? (
        <text fg={COLOR.muted} wrapMode="none">
          tab/←→ group · type search · ↑↓ navigate · enter select · esc back
        </text>
      ) : null}
    </box>
  );
}

function Composer({ controller, snapshot, disabled, focused, locale, onValueChange, onBeforeSend, onCommandInput, editorRef, imagePathRegistry, height = 1, backgroundColor }: {
  readonly controller: ChatController;
  readonly snapshot: ChatSnapshot;
  readonly disabled: boolean;
  readonly focused: boolean;
  readonly locale: TuiLocale;
  readonly onValueChange: (value: string) => void;
  readonly onBeforeSend: () => void;
  readonly onCommandInput: (input: string) => boolean;
  readonly editorRef: RefObject<TextareaRenderable | null>;
  readonly imagePathRegistry: Map<string, string>;
  readonly height?: number;
  readonly backgroundColor?: string;
}) {
  const editor = editorRef;
  const chipifyPendingRef = useRef(false);
  const lastComposerValueRef = useRef('');

  const applyImageChips = () => {
    const current = editor.current;
    if (!current || chipifyPendingRef.current) return;
    const rawValue = current.plainText ?? '';
    const value = mergeImagePasteWithExistingDraft(rawValue, lastComposerValueRef.current);
    const chipped = chipifyImagePathsInText(value);
    if (chipped === rawValue) {
      lastComposerValueRef.current = rawValue;
      onValueChange(rawValue);
      return;
    }
    const rawPaths = extractImagePathTokens(value);
    if (rawPaths.length > 0) registerImagePathKeys(imagePathRegistry, rawPaths);
    chipifyPendingRef.current = true;
    current.setText(chipped);
    try {
      // Keep caret near end after rewrite so paste+type still feels natural.
      (current as { cursorOffset?: number }).cursorOffset = chipped.length;
    } catch {
      // Some OpenTUI builds may not expose cursorOffset; ignore.
    }
    chipifyPendingRef.current = false;
    lastComposerValueRef.current = chipped;
    onValueChange(chipped);
  };

  const submit = () => {
    const value = editor.current?.plainText ?? '';
    const trimmed = value.trim();
    if (!trimmed || disabled || snapshot.status !== 'idle') return;
    if (isSlashCommandInput(trimmed)) {
      if (!onCommandInput(trimmed)) return;
      editor.current?.clear();
      lastComposerValueRef.current = '';
      onValueChange('');
      return;
    }
    editor.current?.clear();
    lastComposerValueRef.current = '';
    onValueChange('');
    onBeforeSend();
    void (async () => {
      const attachment = await loadLocalImageAttachments(value, { pathByKey: imagePathRegistry });
      // Keep typed text only. Pure-image turns send empty content + images[];
      // ChatHistory renders a visible [Image] chip from message.images.
      // Fall back to displayContent only when no images loaded (path missing).
      const textToSend = attachment.text.trim()
        ? attachment.text
        : (attachment.images.length > 0 ? '' : attachment.displayContent);
      if (!textToSend.trim() && attachment.images.length === 0) return;
      void controller.send(textToSend, attachment.images.length > 0 ? { images: attachment.images } : undefined);
    })();
  };

  return (
    <ThemedTextarea
        ref={editor}
        focused={focused && !disabled}
        height={height}
        backgroundColor={backgroundColor}
        placeholder={composerPlaceholder(locale, disabled)}
        textColor={COLOR.text}
        focusedTextColor={COLOR.text}
        wrapMode="word"
        onContentChange={() => applyImageChips()}
        onKeyDown={(event) => {
          const action = composerEnterAction({
            keyName: event.name,
            shift: event.shift,
            eventType: event.eventType,
          });
          if (action === 'none') return;
          // OpenTUI's default bindings only map plain Enter → newline and have
          // no shift+return binding; control-char fallback also drops \r. Own
          // both submit and newline so Shift+Enter actually inserts a line and
          // onContentChange can grow the composer shell (up to 5 rows).
          event.preventDefault();
          event.stopPropagation();
          if (action === 'newline') {
            editor.current?.newLine();
            return;
          }
          if (action === 'submit') submit();
        }}
      />
  );
}


function ComposerDock({
  controller,
  snapshot,
  disabled,
  focused,
  locale,
  onValueChange,
  onBeforeSend,
  onCommandInput,
  editorRef,
  imagePathRegistry,
  status,
  statusLayout,
  layout,
  draft,
  slashOpen,
  slashItems,
  slashSelection,
  slashMaxVisible,
  slashShowDescriptions,
  modelPickerOpen,
  modelPickerTitle,
  modelPickerSubtitle,
  modelPickerGroups,
  modelPickerActiveGroup,
  modelPickerQuery,
  modelPickerRows,
  modelPickerSelection,
  modelPickerMaxVisible,
  modelPickerShowHint,
}: {
  readonly controller: ChatController;
  readonly snapshot: ChatSnapshot;
  readonly disabled: boolean;
  readonly focused: boolean;
  readonly locale: TuiLocale;
  readonly onValueChange: (value: string) => void;
  readonly onBeforeSend: () => void;
  readonly onCommandInput: (input: string) => boolean;
  readonly editorRef: RefObject<TextareaRenderable | null>;
  readonly imagePathRegistry: Map<string, string>;
  readonly status: ComposerStatus;
  readonly statusLayout: ComposerStatusLayout;
  readonly layout: ReturnType<typeof responsiveLayout>;
  readonly draft: string;
  readonly slashOpen: boolean;
  readonly slashItems: readonly TuiCommand[];
  readonly slashSelection: number;
  readonly slashMaxVisible: number;
  readonly slashShowDescriptions: boolean;
  readonly modelPickerOpen: boolean;
  readonly modelPickerTitle: string;
  readonly modelPickerSubtitle?: string;
  readonly modelPickerGroups: readonly string[];
  readonly modelPickerActiveGroup: string | null;
  readonly modelPickerQuery: string;
  readonly modelPickerRows: readonly ModelPickerViewRow[];
  readonly modelPickerSelection: number;
  readonly modelPickerMaxVisible: number;
  readonly modelPickerShowHint: boolean;
}) {
  const menuReserve = slashOpen
    ? Math.min(slashMaxVisible, Math.max(1, slashItems.length)) + 1
    : modelPickerOpen
      // groups + search + optional hint around the visible rows
      ? Math.min(modelPickerMaxVisible, Math.max(1, modelPickerRows.length)) + 3
      : 0;
  const terminal = useTerminalDimensions();
  const dividerWidth = composerContentWidth(terminal.width, layout.outerPadding);
  const composerLayout = composerLayoutModel({
    draft,
    contentWidth: dividerWidth,
    runtimeStatus: snapshot.status,
  });
  const composerBackground = COLOR.background;

  return (
    <box
      flexDirection="column"
      flexShrink={0}
      width="100%"
      paddingTop={menuReserve}
      paddingLeft={layout.outerPadding}
      paddingRight={layout.outerPadding}
    >
      {/* Running status sits above the quiet divider; the line separates activity from the input. No card or enclosing border. */}
      {composerLayout.showRunningStatus ? (
        <ComposerRunningStatusLabel
          locale={locale}
          runStatus={snapshot.status === 'cancelling' ? 'cancelling' : snapshot.status === 'compacting' ? 'compacting' : 'running'}
          width={dividerWidth}
        />
      ) : null}
      <ComposerModeDivider width={dividerWidth} />
      <box position="relative" width="100%" height={composerLayout.shellRows} overflow="visible">
        {slashOpen ? (
          <SlashCommandMenu
            commands={slashItems}
            selectedIndex={slashSelection}
            maxVisible={slashMaxVisible}
            showDescriptions={slashShowDescriptions}
            bottom={composerLayout.pickerBottom}
          />
        ) : null}
        {modelPickerOpen ? (
          <ModelPickerMenu
            title={modelPickerTitle}
            subtitle={modelPickerSubtitle}
            groups={modelPickerGroups}
            activeGroup={modelPickerActiveGroup}
            query={modelPickerQuery}
            rows={modelPickerRows}
            selectedIndex={modelPickerSelection}
            maxVisible={modelPickerMaxVisible}
            showHint={modelPickerShowHint}
            bottom={composerLayout.pickerBottom}
          />
        ) : null}
        <box flexDirection="row" width="100%">
          <text fg={composerLayout.showRunningStatus ? COLOR.warning : COLOR.accent}>
            <strong>{composerLayout.promptGlyph}</strong>
          </text>
          <box flexGrow={1} paddingLeft={1}>
            <Composer
              controller={controller}
              snapshot={snapshot}
              disabled={disabled}
              focused={focused}
              locale={locale}
              onValueChange={onValueChange}
              onBeforeSend={onBeforeSend}
              onCommandInput={onCommandInput}
              editorRef={editorRef}
              imagePathRegistry={imagePathRegistry}
              height={composerLayout.inputRows}
              backgroundColor={composerBackground}
            />
          </box>
        </box>
      </box>
      <ComposerStatusBar status={status} layout={statusLayout} />
    </box>
  );
}


function collectMessageTools(message: ChatMessage): ToolPresentation[] {
  const tools: ToolPresentation[] = [];
  if (message.tools && message.tools.length > 0) tools.push(...message.tools);
  if (message.tool) tools.push(message.tool);
  if (message.segments) {
    for (const segment of message.segments) {
      if (segment.type === 'tool-call') tools.push(segment.tool);
    }
  }
  return tools;
}

/** Latest unanswered Ask user request after the last user message. */
function findPendingUserInput(messages: readonly ChatMessage[]): TuiUserInputRequest | null {
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      lastUserIndex = index;
      break;
    }
  }
  for (let index = messages.length - 1; index > lastUserIndex; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== 'assistant') continue;
    const tools = collectMessageTools(message);
    for (let toolIndex = tools.length - 1; toolIndex >= 0; toolIndex -= 1) {
      const request = extractUserInputRequest(tools[toolIndex]);
      if (request) return request;
    }
  }
  return null;
}


export function App({ host, model, modelLabel, modelSelection, languageStore, themeStore, onQuit }: {
  readonly host: TuiHost;
  readonly model: ChatModelPort;
  readonly modelLabel: string;
  readonly modelSelection?: TuiModelSelectionControl;
  readonly languageStore?: TuiLanguageStore;
  readonly themeStore?: TuiThemeStore;
  readonly onQuit: () => void;
}) {
  const terminal = useTerminalDimensions();
  const controllerRef = useRef<ChatController | null>(null);
  const composerRef = useRef<TextareaRenderable | null>(null);
  // 与 Desktop 对齐：goal 模式的自驱执行由共享 Goal Runner（goal-plan-store
  // + goal-runner.mjs）承担；此处只保留占位 ref，真实创建在 controller 就绪后
  // （见下方 useMemo(createTuiSharedGoalRunner)），因为 runGoalTurn 要驱动 chat 会话。
  const planCoordinator = useMemo(() => createPlanCoordinator({
    sessionId: 'tui-chat',
    goalExecution: {
      // Plan 审批通过后的执行统一交给共享 Runner（由 goal-runner-adapter 里
      // store onChange 的 auto-start 闸门负责）；这里不再用旧局部 goalRunner。
      create: () => {},
    },
  }), []);
  const selectedModelRef = useRef<RuntimeModelSelection | null>(
    modelSelection?.getSelection() ?? null,
  );
  const persistence = useMemo(() => createTuiConversationPersistence({
    workspacePath: host.workspaceRoot,
    initialMode: 'chat',
    initialModel: modelSelection?.getSelection() ?? {
      providerId: 'unknown',
      modelId: modelLabel,
      reasoningEffort: 'default',
    },
  }), [host.workspaceRoot, modelLabel, modelSelection]);
  const controller = useMemo(
    () => createChatController({
      host,
      model,
      planCoordinator,
      getConversationId: () => persistence.ensureConversation(),
      getContextWindow: () => {
        const selection = selectedModelRef.current;
        if (!selection || !modelSelection) return undefined;
        return modelSelection.catalog.find(
          (entry) => entry.providerId === selection.providerId
            && entry.modelId === selection.modelId,
        )?.contextWindow;
      },
    }),
    [host, model, planCoordinator, modelSelection, persistence],
  );
  controllerRef.current = controller;
  const [snapshot, setSnapshot] = useState(() => controller.getSnapshot());
  const [externalConversationRevision, setExternalConversationRevision] = useState(0);
  // 与 Desktop 对齐的共享 Goal Runner：goal_create_plan 写盘后由 store onChange
  // 的 auto-start 闸门 kick；runGoalTurn 通过 controller.send 驱动会话继续执行。
  // 仅在共享 store 存在（host.goalBridge）时创建；测试 host 可能不带 bridge。
  const goalRunner = useMemo(() => {
    if (!host.goalBridge) return null;
    try {
      return createTuiSharedGoalRunner({
        bridge: host.goalBridge,
        chat: controller,
        getConversationId: () => persistence.getConversationId(),
      });
    } catch {
      return null;
    }
  }, [host, controller]);
  // Shared Desktop goal-plan store snapshots for this conversation.
  // Keep formal Goal history as a list; the selected plan only controls presentation.
  const [sharedGoalPlans, setSharedGoalPlans] = useState<readonly TuiGoalPlan[]>([]);
  const [selectedGoalPlanId, setSelectedGoalPlanId] = useState<string | null>(null);
  const sharedGoalPlan = useMemo(
    () => sharedGoalPlans.find((plan) => plan.planId === selectedGoalPlanId) ?? null,
    [sharedGoalPlans, selectedGoalPlanId],
  );
  const activeGoalPlanId = useMemo(
    () => selectActiveGoalPlanId(sharedGoalPlans),
    [sharedGoalPlans],
  );
  const activeSharedGoalPlan = useMemo(
    () => sharedGoalPlans.find((plan) => plan.planId === activeGoalPlanId) ?? null,
    [activeGoalPlanId, sharedGoalPlans],
  );
  // Runner 领域事件触发的轻量重拉信号（started/tickCompleted/blocked/... 时 +1）。
  const [goalEventTick, setGoalEventTick] = useState(0);
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const [approvalSelection, setApprovalSelection] = useState(0);
  const [planSelection, setPlanSelection] = useState(0);
  const [commandNotice, setCommandNotice] = useState<string | null>(null);
  const [leaderArmed, setLeaderArmed] = useState(false);
  const [skills, setSkills] = useState<readonly TuiSkillSummary[]>(() => host.skillMcpBridge?.listSkills() ?? []);
  const [mcpServers, setMcpServers] = useState<readonly TuiMcpServerSummary[]>(() => host.skillMcpBridge?.listMcpServers() ?? []);
  const renderer = useRenderer();
  const selectedTextRef = useRef('');
  const lastAutoCopiedTextRef = useRef('');
  const selectionCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hasTextSelection, setHasTextSelection] = useState(false);

  const copySelectionText = useCallback((text: string, options?: { readonly clearOnSuccess?: boolean }) => {
    const textToCopy = text;
    if (textToCopy.trim().length === 0) {
      setCommandNotice(selectionCopyNotice({ ok: false, method: 'none', error: 'empty selection' }, 0));
      return;
    }
    void copyTextToClipboard(textToCopy, {
      writeOsc52: (value) => renderer.copyToClipboardOSC52(value),
    }).then((result) => {
      setCommandNotice(selectionCopyNotice(result, textToCopy.length));
      if (!result.ok) return;
      lastAutoCopiedTextRef.current = textToCopy;
      if (options?.clearOnSuccess) {
        selectedTextRef.current = '';
        setHasTextSelection(false);
        renderer.clearSelection();
      }
    });
  }, [renderer]);

  useSelectionHandler((selection) => {
    const next = selection?.getSelectedText?.() ?? '';
    selectedTextRef.current = next;
    setHasTextSelection(next.length > 0);

    if (selectionCopyTimerRef.current) {
      clearTimeout(selectionCopyTimerRef.current);
      selectionCopyTimerRef.current = null;
    }

    // Empty selection: reset dedupe so re-selecting the same text can copy again.
    if (next.trim().length === 0) {
      lastAutoCopiedTextRef.current = '';
      return;
    }

    // Debounce while the user is still dragging to avoid intermediate copies.
    selectionCopyTimerRef.current = setTimeout(() => {
      selectionCopyTimerRef.current = null;
      const text = selectedTextRef.current;
      if (text.trim().length === 0) return;
      if (text === lastAutoCopiedTextRef.current) return;
      copySelectionText(text);
    }, 180);
  });

  useEffect(() => {
    return () => {
      if (selectionCopyTimerRef.current) {
        clearTimeout(selectionCopyTimerRef.current);
        selectionCopyTimerRef.current = null;
      }
    };
  }, []);
  const [resumeItems, setResumeItems] = useState<readonly TuiConversationSummary[]>([]);
  const [selectedModel, setSelectedModel] = useState<RuntimeModelSelection | null>(
    () => modelSelection?.getSelection() ?? null,
  );
  selectedModelRef.current = selectedModel;
  const [modelPickerQuery, setModelPickerQuery] = useState('');
  const [modelPickerStage, setModelPickerStage] = useState<ModelPickerStage>('models');
  const [modelPickerGroup, setModelPickerGroup] = useState<string | null>(null);
  const [modelPickerPending, setModelPickerPending] = useState<{
    readonly providerId: string;
    readonly modelId: string;
  } | null>(null);
  const [accessLevel, setAccessLevel] = useState<LocalAccessLevel>(() => host.getAccessLevel());
  const [locale, setLocale] = useState<TuiLocale>(() => languageStore?.getLocale() ?? 'zh-CN');
  const [themeMode, setThemeMode] = useState<TuiThemeMode>(() => themeStore?.getMode() ?? 'dark');
  // Force chrome re-render after palette mutation (COLOR is a shared mutable object).
  const [, setThemeTick] = useState(0);
  const [composerDraft, setComposerDraft] = useState('');
  const imagePathRegistryRef = useRef(new Map<string, string>());
  const [experience, setExperience] = useState<TuiExperienceState>(() => createTuiExperienceState());
  const [renderWindowState, setRenderWindowState] = useState<ConversationRenderWindowState>(
    () => createConversationRenderWindowState(),
  );
  const renderWindowConversationId = persistence.getConversationId()
    ?? snapshot.session?.conversationId
    ?? null;
  const renderProjection = useMemo(
    () => projectConversationRenderWindow(snapshot.messages, renderWindowState),
    [snapshot.messages, renderWindowState],
  );
  useEffect(() => {
    setRenderWindowState(createConversationRenderWindowState());
  }, [renderWindowConversationId]);
  const visibleTurn = snapshot.session?.activeTurn ?? snapshot.session?.lastTurn;
  const commandSurface = experience.surface.type === 'picker' && experience.surface.picker === 'command'
    ? experience.surface
    : null;
  const skillSurface = experience.surface.type === 'picker' && experience.surface.picker === 'skill'
    ? experience.surface
    : null;
  const mcpSurface = experience.surface.type === 'picker' && experience.surface.picker === 'mcp'
    ? experience.surface
    : null;
  const goalSurface = experience.surface.type === 'picker' && experience.surface.picker === 'goal'
    ? experience.surface
    : null;
  const slashSurface = experience.surface.type === 'slash-suggestions'
    ? experience.surface
    : null;
  const activeGoalRunnerStatus = activeSharedGoalPlan?.runner?.status;
  const goalStatus = activeGoalRunnerStatus === 'paused'
    ? 'paused'
    : activeSharedGoalPlan && (
      activeGoalRunnerStatus === 'running'
      || ['accepted', 'executing'].includes(String(activeSharedGoalPlan.status ?? ''))
    )
      ? 'running'
      : 'none';
  const commandItems = commandSurface
    ? filterTuiCommands(commandSurface.query, { goalStatus }, locale)
    : [];
  const slashItems = slashSurface
    ? filterTuiCommands(slashSurface.query, { goalStatus }, locale)
    : [];
  const skillItems = skillSurface
    ? skills.filter((skill) => `${skill.name ?? ''} ${skill.skillId} ${skill.description ?? ''}`.toLowerCase().includes(skillSurface.query.toLowerCase()))
    : [];
  const mcpItems = mcpSurface
    ? mcpServers.filter((server) => `${server.displayName} ${server.id}`.toLowerCase().includes(mcpSurface.query.toLowerCase()))
    : [];
  const goalPickerPlans = goalSurface
    ? filterGoalPlanHistory(sharedGoalPlans, goalSurface.query)
    : [];
  const modeSurface = experience.surface.type === 'picker' && experience.surface.picker === 'mode'
    ? experience.surface
    : null;
  const resumeSurface = experience.surface.type === 'picker' && experience.surface.picker === 'resume'
    ? experience.surface
    : null;
  const modelSurface = experience.surface.type === 'picker' && experience.surface.picker === 'model'
    ? experience.surface
    : null;
  const helpSurface = experience.surface.type === 'picker' && experience.surface.picker === 'help'
    ? experience.surface
    : null;
  const helpSections = useMemo(
    () => (helpSurface ? buildTuiHelpSections({ goalStatus }, locale) : []),
    [goalStatus, helpSurface, locale],
  );
  useEffect(() => {
    if (!modelSurface) {
      setModelPickerQuery('');
      setModelPickerStage('models');
      setModelPickerPending(null);
      return;
    }
    if (!modelSelection || !selectedModel) return;
    if (modelPickerGroup) return;
    const groups = [];
    const seen = new Set();
    for (const entry of modelSelection.catalog) {
      const parts = entry.displayName.split(' · ');
      const group = parts.length > 1 ? parts[parts.length - 1] : 'Models';
      if (seen.has(group)) continue;
      seen.add(group);
      groups.push(group);
    }
    const current = modelSelection.catalog.find((entry) =>
      entry.providerId === selectedModel.providerId && entry.modelId === selectedModel.modelId
    );
    const currentGroup = current
      ? (current.displayName.includes(' · ') ? current.displayName.split(' · ').slice(-1)[0] : groups[0] ?? null)
      : (groups[0] ?? null);
    setModelPickerGroup(currentGroup ?? null);
  }, [modelSurface, modelSelection, selectedModel, modelPickerGroup]);


  const permissionSurface = experience.surface.type === 'picker' && experience.surface.picker === 'permission'
    ? experience.surface
    : null;
  const languageSurface = experience.surface.type === 'picker' && experience.surface.picker === 'language'
    ? experience.surface
    : null;
  const themeSurface = experience.surface.type === 'picker' && experience.surface.picker === 'theme'
    ? experience.surface
    : null;
  const modelPickerView = modelSelection && selectedModel
    ? buildModelPickerView({
      control: modelSelection,
      current: selectedModel,
      query: modelPickerQuery,
      stage: modelPickerStage,
      activeGroup: modelPickerGroup,
      pendingModel: modelPickerPending,
    })
    : null;
  const modelPickerRows = modelPickerView?.rows ?? [];
  const modelPickerSelectableRows = modelPickerView?.selectableRows ?? [];
  const modelPickerGroupLabels = modelSelection
    ? (modelPickerView?.groups ?? []).map((group) =>
      formatModelPickerGroupLabel(group, modelPickerGroupCounts(modelSelection)))
    : [];

  useEffect(() => {
    if (!modelSurface || !modelSelection || !modelPickerView) return;
    if (modelPickerStage !== 'models') return;
    if (modelPickerQuery.trim()) return;
    if (modelPickerSelectableRows.length > 0) return;
    const counts = modelPickerGroupCounts(modelSelection);
    const next = modelPickerView.groups.find((group) => (counts.get(group)?.available ?? 0) > 0) ?? null;
    if (next && next !== modelPickerGroup) {
      setModelPickerGroup(next);
      setExperience((current) => ({
        ...current,
        surface: { type: 'picker', picker: 'model', query: '', selectedIndex: 0 },
      }));
    }
  }, [
    modelSurface,
    modelSelection,
    modelPickerView,
    modelPickerStage,
    modelPickerQuery,
    modelPickerSelectableRows.length,
    modelPickerGroup,
  ]);
  const commandSelection = commandSurface?.selectedIndex ?? 0;
  const slashSelection = slashSurface?.selectedIndex ?? 0;
  const modeSelection = modeSurface?.selectedIndex ?? 0;
  const modelPickerSelection = modelSurface?.selectedIndex ?? 0;
  const goalPickerSelection = Math.min(
    goalSurface?.selectedIndex ?? 0,
    Math.max(0, goalPickerPlans.length - 1),
  );
  const permissionSelection = permissionSurface?.selectedIndex ?? permissionPolicyIndex(accessLevel);
  const languageSelection = languageSurface?.selectedIndex ?? languageIndex(locale);
  const themeSelection = themeSurface?.selectedIndex
    ?? Math.max(0, TUI_THEME_OPTIONS.findIndex((option) => option.mode === themeMode));
  const pendingUserInput = findPendingUserInput(snapshot.messages);
  const userInputOptions = pendingUserInput ? toUserInputOptions(pendingUserInput.options) : [];
  const userInputSurface = experience.surface.type === 'user-input' ? experience.surface : null;
  const userInputSelection = userInputSurface?.selectedIndex ?? 0;
  const activeTurnMode = snapshot.activeTurnMode;
  const selectedModelLabel = selectedModel && modelSelection
    ? modelSelectionLabel(modelSelection, selectedModel)
    : modelLabel;
  const sessionTopbarModel = sessionTopbarModelLabel(
    modelSelection,
    selectedModel,
    modelLabel,
  );
  const sessionWorkspacePath = compactWorkspacePath(host.workspaceRoot);
  const contextWindow = modelSelection?.catalog.find(
    (entry) => entry.providerId === selectedModel?.providerId
      && entry.modelId === selectedModel?.modelId,
  )?.contextWindow;
  const composerStatus = createComposerStatus({
    workspaceRoot: host.workspaceRoot,
    mode: snapshot.mode,
    accessLevel,
    locale,
    modelLabel: selectedModelLabel,
    reasoningEffort: selectedModel?.reasoningEffort,
    usage: snapshot.usage,
    contextWindow,
    nextRequestInputTokens: snapshot.nextRequestInputTokens,
  });
  const layout = responsiveLayout(terminal.width, terminal.height);
  const topbarDividerWidth = composerContentWidth(terminal.width, layout.outerPadding);
  const goalView = goalStatusFromSharedPlan(sharedGoalPlan);
  const selectedGoalIndex = Math.max(
    0,
    sharedGoalPlans.findIndex((plan) => plan.planId === selectedGoalPlanId),
  );
  const missionPosition = selectedGoalIndex + 1;
  const goalLayout = goalStatusLayout(terminal.width);
  const pickerLayout = responsivePickerLayout(
    terminal.height,
    TUI_MODES.length,
    layout.showDescriptions,
    layout.showHints,
  );
  const slashMaxVisible = layout.density === 'wide' || layout.density === 'compact'
    ? 5
    : layout.density === 'narrow'
      ? 3
      : 2;
  const welcomeModelMaxVisible = layout.density === 'wide' || layout.density === 'compact'
    ? 4
    : layout.density === 'narrow'
      ? 3
      : 2;
  const welcomeModelVisibleRows = Math.min(welcomeModelMaxVisible, Math.max(1, modelPickerSelectableRows.length)) + 2;
  const commandWindow = commandSurface
    ? slashCommandWindow(commandItems, commandSelection, pickerLayout.commandMaxVisible)
    : [];
  const composerStatusLayout: ComposerStatusLayout = terminal.width >= 160
    ? 'wide'
    : terminal.width >= 72
      ? 'compact'
      : 'narrow';
  const wordmarkVariant = terminal.width >= 76
    ? 'full'
    : terminal.width >= 42
      ? 'half'
      : 'narrow';
  const isComposerInputFocused = experience.surface.type === 'composer'
    || experience.surface.type === 'slash-suggestions';
  const isComposerSurface = isComposerInputFocused || Boolean(modelSurface);

  useEffect(() => {
    if (!pendingUserInput || pendingUserInput.options.length === 0) {
      if (experience.surface.type === 'user-input') {
        setExperience((current) => escapeFooter(current));
      }
      return;
    }
    if (approval || snapshot.plan?.status === 'awaiting_approval') return;
    if (experience.surface.type === 'user-input') return;
    setExperience((current) => showUserInput(current));
  }, [pendingUserInput, approval, snapshot.plan?.status, experience.surface.type]);

  useEffect(() => {
    if (!resumeSurface) return;
    if (snapshot.status !== 'idle') {
      setCommandNotice('Cannot resume a session while a response is running');
      setExperience((current) => escapeFooter(current));
      return;
    }
    setResumeItems(persistence.listResumable());
  }, [persistence, resumeSurface, snapshot.status]);

  useEffect(() => {
    if (!commandNotice) return;
    const timeout = setTimeout(() => setCommandNotice(null), COMMAND_NOTICE_DURATION_MS);
    return () => clearTimeout(timeout);
  }, [commandNotice]);

  // Goal state may decorate the empty session, but it must not replace the CLI home.
  // The confirmed workspace redesign begins only after the conversation has content.
  const isWelcome = snapshot.messages.length === 0
    && !approval
    && snapshot.plan?.status !== 'awaiting_approval'
    && !pendingUserInput
    && !snapshot.error
    && isComposerSurface;

  useEffect(() => controller.subscribe((next) => {
    persistence.syncSnapshot(next);
    setSnapshot(next);
  }), [controller, persistence]);
  useEffect(() => persistence.subscribeExternalChanges(() => {
    setExternalConversationRevision((revision) => revision + 1);
  }), [persistence]);
  useEffect(() => {
    if (externalConversationRevision === 0 || snapshot.status !== 'idle') return;
    const conversationId = persistence.getConversationId();
    if (!conversationId) {
      setExternalConversationRevision(0);
      return;
    }
    const conversation = persistence.loadConversation(conversationId);
    setExternalConversationRevision(0);
    if (!conversation || !resumeTuiConversation(controller, persistence, conversation)) return;
    if (conversation.modelSelection && modelSelection) {
      modelSelection.setSelection(conversation.modelSelection);
      setSelectedModel(conversation.modelSelection);
    }
  }, [controller, externalConversationRevision, modelSelection, persistence, snapshot.status]);
  useEffect(() => {
    if (!goalRunner) return undefined;
    // 用 runner 领域事件驱动轻量重拉（替代旧局部 RuntimeGoalController 订阅）。
    const unsubscribe = goalRunner.subscribe(() => { setGoalEventTick((tick) => tick + 1); });
    return unsubscribe;
  }, [goalRunner]);
  useEffect(() => host.subscribeApproval((next) => {
    setApprovalSelection(0);
    setApproval(next);
  }), [host]);
  // Shared store events keep CLI and Desktop panels on the same persisted Goal facts.
  // Full details are required before applying Desktop's display rules because
  // index metadata does not contain activation.kind (used to hide intake plans).
  useEffect(() => {
    const bridge = host.goalBridge;
    if (!bridge) return undefined;
    const conversationId = persistence.getConversationId();
    if (!conversationId) {
      setSharedGoalPlans([]);
      setSelectedGoalPlanId(null);
      return undefined;
    }
    const refresh = () => {
      const plans = displayableGoalPlans(
        bridge.listPlanDetailsByConversation(conversationId),
      );
      setSharedGoalPlans(plans);
      setSelectedGoalPlanId((current) => selectPreferredGoalPlanId(plans, current));
    };
    refresh();
    return bridge.subscribeChanges((event) => {
      if (!event.conversationId || event.conversationId === conversationId) refresh();
    });
  }, [host, snapshot.mode, snapshot.status, snapshot.messages.length, snapshot.session?.conversationId, goalEventTick]);

  const handleResumeConversationSummary = useCallback((selected: TuiConversationSummary | undefined) => {
    if (!selected) {
      setCommandNotice('No session selected');
      return;
    }
    if (snapshot.status !== 'idle') {
      setCommandNotice('Cannot resume a session while a response is running');
      setExperience((current) => escapeFooter(current));
      queueMicrotask(() => composerRef.current?.focus());
      return;
    }
    const conversation = persistence.loadConversation(selected.id);
    if (!conversation) {
      setCommandNotice('Failed to load selected session');
      setResumeItems(persistence.listResumable());
      return;
    }
    const resumed = resumeTuiConversation(controller, persistence, conversation);
    if (!resumed) {
      setCommandNotice('Cannot resume a session while a response is running');
      setExperience((current) => escapeFooter(current));
      queueMicrotask(() => composerRef.current?.focus());
      return;
    }
    if (conversation.modelSelection) {
      modelSelection?.setSelection(conversation.modelSelection);
      setSelectedModel(conversation.modelSelection);
    }
    setExperience((current) => escapeFooter({
      ...current,
      mode: conversation.mode,
    }));
    setRenderWindowState(createConversationRenderWindowState());
    setComposerDraft('');
    queueMicrotask(() => composerRef.current?.focus());
  }, [controller, modelSelection, persistence, snapshot.status]);

  const selectMode = (mode: TuiMode) => {
    controller.setMode(mode);
    setExperience((current) => escapeFooter({ ...current, mode }));
    queueMicrotask(() => composerRef.current?.focus());
  };

  const runCommand = (command: TuiCommand) => executeTuiCommand(command, {
    clearChat: () => {
      const cleared = controller.clear();
      if (cleared) {
        persistence.startNewConversation(controller.getSnapshot().mode);
        setRenderWindowState(createConversationRenderWindowState());
      }
      return cleared;
    },
    startNewSession: () => {
      const started = controller.clear();
      if (started) {
        persistence.startNewConversation(controller.getSnapshot().mode);
        setRenderWindowState(createConversationRenderWindowState());
        setComposerDraft('');
        composerRef.current?.clear();
        setSharedGoalPlans([]);
        setSelectedGoalPlanId(null);
        setExperience((current) => escapeFooter(current));
        queueMicrotask(() => composerRef.current?.focus());
      }
      return started;
    },
    compactContext: async () => (await controller.compact()).notice,
    navigateHistory: (direction) => {
      if (direction === 'earlier' && !renderProjection.window.canLoadEarlier) {
        return 'Already at the beginning of the conversation';
      }
      if (direction === 'later' && !renderProjection.window.canLoadLater) {
        setRenderWindowState(createConversationRenderWindowState());
        return 'Already showing the latest conversation';
      }
      const nextState = navigateConversationHistory(
        snapshot.messages,
        renderWindowState,
        direction,
      );
      const nextProjection = projectConversationRenderWindow(snapshot.messages, nextState);
      setRenderWindowState(nextState);
      if (nextProjection.window.mode === 'latest') return 'Showing the latest conversation';
      return `History page · ${nextProjection.window.hiddenBefore} earlier · ${nextProjection.window.hiddenAfter} newer messages hidden`;
    },
    controlGoal: (control) => {
      if (!activeSharedGoalPlan || !goalRunner) return 'No active goal';
      const planId = activeSharedGoalPlan.planId;
      const runnerStatus = activeSharedGoalPlan.runner?.status ?? activeSharedGoalPlan.status;
      if (control === 'pause' && runnerStatus === 'running') {
        goalRunner.pause(planId);
        return 'Goal paused';
      }
      if (control === 'resume' && runnerStatus === 'paused') {
        void goalRunner.resume(planId);
        return 'Goal resumed';
      }
      if (control === 'cancel' && ['accepted', 'executing', 'running', 'paused'].includes(String(runnerStatus))) {
        controller.cancel();
        goalRunner.clear(planId);
        return 'Goal cancelled';
      }
      return `Goal is ${runnerStatus}; ${control} is unavailable`;
    },
    quit: onQuit,
    setNotice: setCommandNotice,
    updateExperience: setExperience,
  });

  const runSlashCommandInput = (input: string): boolean => {
    const command = resolveTuiCommandInput(input, { goalStatus }, locale);
    if (!command) {
      setCommandNotice(`Unknown command: ${input}`);
      return true;
    }
    runCommand(command);
    return true;
  };

  const openGoalHistory = () => {
    setExperience((current) => openPicker(current, 'goal'));
  };

  const selectGoalFromHistory = (planId: string) => {
    setSelectedGoalPlanId(planId);
    setExperience((current) => escapeFooter(current));
    queueMicrotask(() => composerRef.current?.focus());
  };

  useKeyboard((key) => {
    const keyMeta = Boolean((key as { meta?: boolean; super?: boolean }).meta || (key as { super?: boolean }).super);
    const liveSelection = renderer.getSelection()?.getSelectedText?.() ?? selectedTextRef.current;
    const hasSelection = liveSelection.trim().length > 0 || hasTextSelection;
    const control = runtimeControlAction({
      keyName: key.name,
      ctrl: key.ctrl,
      meta: keyMeta,
      isRunning: snapshot.status !== 'idle' || goalStatus === 'running',
      hasSurface: experience.surface.type !== 'composer'
        && experience.surface.type !== 'slash-suggestions',
      hasDraft: composerDraft.length > 0,
      hasSelection,
    });
    if (control === 'copy-selection') {
      const textToCopy = liveSelection.trim().length > 0 ? liveSelection : selectedTextRef.current;
      copySelectionText(textToCopy, { clearOnSuccess: true });
      return;
    }
    if (control === 'interrupt') {
      controller.cancel();
      if (activeSharedGoalPlan && goalRunner) {
        const runnerStatus = activeSharedGoalPlan.runner?.status ?? activeSharedGoalPlan.status;
        if (['accepted', 'executing', 'running', 'paused'].includes(String(runnerStatus))) {
          goalRunner.clear(activeSharedGoalPlan.planId);
        }
      }
      queueMicrotask(() => composerRef.current?.focus());
      return;
    }
    if (control === 'dismiss-surface') {
      setExperience((current) => escapeFooter(current));
      queueMicrotask(() => composerRef.current?.focus());
      return;
    }
    if (control === 'clear-composer') {
      composerRef.current?.setText('');
      setComposerDraft('');
      setExperience((current) => syncSlashSuggestions(current, ''));
      queueMicrotask(() => composerRef.current?.focus());
      return;
    }

    const eventType = (key as { eventType?: 'press' | 'repeat' | 'release' }).eventType
      ?? ((key as { repeated?: boolean }).repeated ? 'repeat' : 'press');
    const leader = resolveLeaderKey({
      armed: leaderArmed,
      keyName: key.name,
      ctrl: key.ctrl,
      meta: keyMeta,
      shift: Boolean(key.shift),
      eventType,
    });
    if (leader.type !== 'none') {
      key.preventDefault?.();
      key.stopPropagation?.();
      if (leader.type === 'arm') {
        setLeaderArmed(true);
        setCommandNotice('Ctrl+X · M model · O mode · P permissions · N new · L resume · 1/2/3 mode');
        return;
      }
      if (leader.type === 'consume') {
        return;
      }
      setLeaderArmed(false);
      if (leader.type === 'cancel') {
        setCommandNotice(null);
        return;
      }
      if (leader.type === 'mode') {
        selectMode(leader.mode);
        return;
      }
      if (leader.type === 'command') {
        const command = resolveTuiCommandInput(`/${leader.commandId}`, { goalStatus }, locale);
        if (command) {
          runCommand(command);
        } else {
          setCommandNotice(`Unknown leader command: ${leader.commandId}`);
        }
        return;
      }
    }

    if (modelSurface) {
      if (key.name === 'escape') {
        if (modelPickerStage === 'efforts') {
          setModelPickerStage('models');
          setModelPickerPending(null);
          setExperience((current) => ({
            ...current,
            surface: {
              type: 'picker',
              picker: 'model',
              query: '',
              selectedIndex: 0,
            },
          }));
          return;
        }
        if (modelPickerQuery.length > 0) {
          setModelPickerQuery('');
          return;
        }
        setModelPickerQuery('');
        setModelPickerStage('models');
        setModelPickerPending(null);
        setExperience((current) => escapeFooter(current));
        queueMicrotask(() => composerRef.current?.focus());
        return;
      }

      if (modelPickerStage === 'models' && modelPickerView && modelPickerView.groups.length > 0) {
        if (key.name === 'tab' || key.name === 'right') {
          const nextGroup = cycleModelPickerGroup(modelPickerView.groups, modelPickerView.activeGroup, key.shift ? -1 : 1);
          setModelPickerGroup(nextGroup);
          setExperience((current) => ({
            ...current,
            surface: { type: 'picker', picker: 'model', query: '', selectedIndex: 0 },
          }));
          return;
        }
        if (key.name === 'left') {
          const nextGroup = cycleModelPickerGroup(modelPickerView.groups, modelPickerView.activeGroup, -1);
          setModelPickerGroup(nextGroup);
          setExperience((current) => ({
            ...current,
            surface: { type: 'picker', picker: 'model', query: '', selectedIndex: 0 },
          }));
          return;
        }
      }

      if (modelPickerStage === 'models' && key.name === 'backspace') {
        setModelPickerQuery((current) => current.slice(0, -1));
        setExperience((current) => ({
          ...current,
          surface: { type: 'picker', picker: 'model', query: '', selectedIndex: 0 },
        }));
        return;
      }

      if (
        modelPickerStage === 'models'
        && !key.ctrl
        && !key.meta
        && typeof key.sequence === 'string'
        && key.sequence.length === 1
        && key.sequence >= ' '
      ) {
        setModelPickerQuery((current) => `${current}${key.sequence}`);
        setExperience((current) => ({
          ...current,
          surface: { type: 'picker', picker: 'model', query: '', selectedIndex: 0 },
        }));
        return;
      }

      if (modelPickerSelectableRows.length === 0) return;

      if (key.name === 'up') {
        setExperience((current) => ({
          ...current,
          surface: moveTuiSurfaceSelection(current.surface, -1, modelPickerSelectableRows.length),
        }));
        return;
      }
      if (key.name === 'down') {
        setExperience((current) => ({
          ...current,
          surface: moveTuiSurfaceSelection(current.surface, 1, modelPickerSelectableRows.length),
        }));
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        const row = modelPickerSelectableRows[modelPickerSelection % modelPickerSelectableRows.length];
        if (!row || !modelSelection) return;
        if (modelPickerStage === 'models' && row.modelRef) {
          const model = modelSelection.catalog.find((entry) =>
            entry.providerId === row.modelRef?.providerId && entry.modelId === row.modelRef?.modelId
          );
          if (model && model.supportedReasoningEfforts.length > 1) {
            setModelPickerPending(row.modelRef);
            setModelPickerStage('efforts');
            setExperience((current) => ({
              ...current,
              surface: { type: 'picker', picker: 'model', query: '', selectedIndex: 0 },
            }));
            return;
          }
        }
        const next = row.selection;
        if (!next) return;
        modelSelection.setSelection(next);
        persistence.syncModel(next);
        setSelectedModel(next);
        setModelPickerQuery('');
        setModelPickerStage('models');
        setModelPickerPending(null);
        setExperience((current) => escapeFooter(current));
        queueMicrotask(() => composerRef.current?.focus());
      }
      return;
    }

    if (permissionSurface) {
      if (key.name === 'escape') {
        setExperience((current) => escapeFooter(current));
        queueMicrotask(() => composerRef.current?.focus());
        return;
      }
      if (key.name === 'up' || key.name === 'left') {
        setExperience((current) => ({
          ...current,
          surface: moveTuiSurfaceSelection(current.surface, -1, TUI_PERMISSION_POLICIES.length),
        }));
        return;
      }
      if (key.name === 'down' || key.name === 'right' || key.name === 'tab') {
        setExperience((current) => ({
          ...current,
          surface: moveTuiSurfaceSelection(current.surface, 1, TUI_PERMISSION_POLICIES.length),
        }));
        return;
      }
      const nextPolicy = permissionPolicyForKey(key.name)
        ?? ((key.name === 'return' || key.name === 'enter')
          ? TUI_PERMISSION_POLICIES[permissionSelection % TUI_PERMISSION_POLICIES.length]?.policy ?? null
          : null);
      if (nextPolicy) {
        const normalized = host.setAccessLevel(nextPolicy);
        setAccessLevel(normalized);
        setExperience((current) => escapeFooter(current));
        queueMicrotask(() => composerRef.current?.focus());
      }
      return;
    }

    if (resumeSurface) {
      if (key.name === 'escape') {
        setExperience((current) => escapeFooter(current));
        queueMicrotask(() => composerRef.current?.focus());
        return;
      }
      if (key.name === 'up' || key.name === 'left') {
        setExperience((current) => ({
          ...current,
          surface: moveTuiSurfaceSelection(current.surface, -1, resumeItems.length),
        }));
        return;
      }
      if (key.name === 'down' || key.name === 'right' || key.name === 'tab') {
        setExperience((current) => ({
          ...current,
          surface: moveTuiSurfaceSelection(current.surface, 1, resumeItems.length),
        }));
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        handleResumeConversationSummary(resumeItems[resumeSurface.selectedIndex]);
        return;
      }
      return;
    }

    if (languageSurface) {
      if (key.name === 'escape') {
        setExperience((current) => escapeFooter(current));
        queueMicrotask(() => composerRef.current?.focus());
        return;
      }
      if (key.name === 'up' || key.name === 'left') {
        setExperience((current) => ({
          ...current,
          surface: moveTuiSurfaceSelection(current.surface, -1, TUI_LANGUAGE_OPTIONS.length),
        }));
        return;
      }
      if (key.name === 'down' || key.name === 'right' || key.name === 'tab') {
        setExperience((current) => ({
          ...current,
          surface: moveTuiSurfaceSelection(current.surface, 1, TUI_LANGUAGE_OPTIONS.length),
        }));
        return;
      }
      if (key.name === 'return') {
        const option = TUI_LANGUAGE_OPTIONS[languageSelection];
        if (option) {
          const next = languageStore?.setLanguage(option.locale) ?? { locale: option.locale, replyLanguage: option.locale };
          setLocale(next.locale);
        }
        setExperience((current) => escapeFooter(current));
        queueMicrotask(() => composerRef.current?.focus());
        return;
      }
      if (typeof key.name === 'string' && key.name.length === 1 && key.name >= '1' && key.name <= '9') {
        const option = TUI_LANGUAGE_OPTIONS[Number(key.name) - 1];
        if (option) {
          const next = languageStore?.setLanguage(option.locale) ?? { locale: option.locale, replyLanguage: option.locale };
          setLocale(next.locale);
          setExperience((current) => escapeFooter(current));
          queueMicrotask(() => composerRef.current?.focus());
        }
        return;
      }
      return;
    }

    if (themeSurface) {
      if (key.name === 'escape') {
        setExperience((current) => escapeFooter(current));
        queueMicrotask(() => composerRef.current?.focus());
        return;
      }
      if (key.name === 'up' || key.name === 'left') {
        setExperience((current) => ({
          ...current,
          surface: moveTuiSurfaceSelection(current.surface, -1, TUI_THEME_OPTIONS.length),
        }));
        return;
      }
      if (key.name === 'down' || key.name === 'right' || key.name === 'tab') {
        setExperience((current) => ({
          ...current,
          surface: moveTuiSurfaceSelection(current.surface, 1, TUI_THEME_OPTIONS.length),
        }));
        return;
      }
      if (key.name === 'return') {
        const option = TUI_THEME_OPTIONS[themeSelection];
        if (option) {
          const next = themeStore?.setMode(option.mode) ?? { mode: option.mode, scheme: option.mode === 'system' ? 'dark' : option.mode };
          setThemeMode(next.mode);
          setThemeTick((tick) => tick + 1);
        }
        setExperience((current) => escapeFooter(current));
        queueMicrotask(() => composerRef.current?.focus());
        return;
      }
      if (typeof key.name === 'string' && key.name.length === 1 && key.name >= '1' && key.name <= '9') {
        const option = TUI_THEME_OPTIONS[Number(key.name) - 1];
        if (option) {
          const next = themeStore?.setMode(option.mode) ?? { mode: option.mode, scheme: option.mode === 'system' ? 'dark' : option.mode };
          setThemeMode(next.mode);
          setThemeTick((tick) => tick + 1);
          setExperience((current) => escapeFooter(current));
          queueMicrotask(() => composerRef.current?.focus());
        }
        return;
      }
      return;
    }

    if (helpSurface) {
      if (
        key.name === 'escape'
        || key.name === 'return'
        || key.name === 'enter'
        || key.name === 'q'
      ) {
        key.preventDefault();
        key.stopPropagation();
        setExperience((current) => escapeFooter(current));
        queueMicrotask(() => composerRef.current?.focus());
      }
      return;
    }

    if (modeSurface) {
      if (key.name === 'escape') {
        setExperience((current) => escapeFooter(current));
        queueMicrotask(() => composerRef.current?.focus());
        return;
      }
      if (key.name === 'up' || key.name === 'left') {
        setExperience((current) => current.surface.type === 'picker'
          ? {
              ...current,
              surface: {
                ...current.surface,
                selectedIndex: (current.surface.selectedIndex - 1 + TUI_MODES.length) % TUI_MODES.length,
              },
            }
          : current);
        return;
      }
      if (key.name === 'down' || key.name === 'right' || key.name === 'tab') {
        setExperience((current) => current.surface.type === 'picker'
          ? {
              ...current,
              surface: {
                ...current.surface,
                selectedIndex: (current.surface.selectedIndex + 1) % TUI_MODES.length,
              },
            }
          : current);
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        const option = TUI_MODES[modeSelection];
        if (option) selectMode(option.mode);
        return;
      }
      const direct = TUI_MODES.find((option) => option.shortcut === key.name);
      if (direct) selectMode(direct.mode);
      return;
    }

    if (slashSurface) {
      if (key.name === 'escape') {
        key.preventDefault();
        key.stopPropagation();
        composerRef.current?.clear();
        setComposerDraft('');
        setExperience((current) => escapeFooter(current));
        return;
      }
      if (key.name === 'up' || key.name === 'down') {
        key.preventDefault();
        key.stopPropagation();
        const direction = key.name === 'up' ? -1 : 1;
        setExperience((current) => current.surface.type === 'slash-suggestions'
          ? {
              ...current,
              surface: {
                ...current.surface,
                selectedIndex: slashItems.length === 0
                  ? 0
                  : (current.surface.selectedIndex + direction + slashItems.length) % slashItems.length,
              },
            }
          : current);
        return;
      }
      if (key.name === 'return' || key.name === 'enter' || key.name === 'tab') {
        key.preventDefault();
        key.stopPropagation();
        const command = slashItems[slashSelection] ?? slashItems[0];
        if (!command) return;
        composerRef.current?.clear();
        setComposerDraft('');
        runCommand(command);
        return;
      }
    }
    if (goalSurface) {
      if (key.name === 'escape') {
        setExperience((current) => escapeFooter(current));
        queueMicrotask(() => composerRef.current?.focus());
        return;
      }
      if (key.name === 'up' || key.name === 'down') {
        const direction = key.name === 'up' ? -1 : 1;
        setExperience((current) => current.surface.type === 'picker' && current.surface.picker === 'goal'
          ? {
              ...current,
              surface: moveTuiSurfaceSelection(current.surface, direction, goalPickerPlans.length),
            }
          : current);
        return;
      }
      if (key.name === 'backspace') {
        setExperience((current) => current.surface.type === 'picker' && current.surface.picker === 'goal'
          ? {
              ...current,
              surface: {
                ...current.surface,
                query: current.surface.query.slice(0, -1),
                selectedIndex: 0,
              },
            }
          : current);
        return;
      }
      if ((key.name === 'return' || key.name === 'enter') && goalPickerPlans.length > 0) {
        const plan = goalPickerPlans[goalPickerSelection] ?? goalPickerPlans[0];
        if (plan) selectGoalFromHistory(plan.planId);
        return;
      }
      if (!key.ctrl && !keyMeta && key.sequence.length === 1 && key.sequence >= ' ') {
        setExperience((current) => current.surface.type === 'picker' && current.surface.picker === 'goal'
          ? {
              ...current,
              surface: {
                ...current.surface,
                query: `${current.surface.query}${key.sequence}`,
                selectedIndex: 0,
              },
            }
          : current);
      }
      return;
    }
    if (skillSurface || mcpSurface) {
      const items = skillSurface ? skillItems : mcpItems;
      const surface = (skillSurface ?? mcpSurface)!;
      const selectedIndex = Math.min(surface.selectedIndex, Math.max(0, items.length - 1));
      if (key.name === 'escape') {
        setExperience((current) => escapeFooter(current));
        queueMicrotask(() => composerRef.current?.focus());
        return;
      }
      if (key.name === 'up' || key.name === 'down') {
        const direction = key.name === 'up' ? -1 : 1;
        setExperience((current) => current.surface.type === 'picker'
          ? { ...current, surface: { ...current.surface, selectedIndex: items.length === 0 ? 0 : (current.surface.selectedIndex + direction + items.length) % items.length } }
          : current);
        return;
      }
      if (key.name === 'r') {
        if (skillSurface) setSkills(host.skillMcpBridge?.refreshSkills() ?? []);
        else setMcpServers(host.skillMcpBridge?.refreshMcp() ?? []);
        return;
      }
      if (key.name === 'space') {
        if (skillSurface) {
          const skill = skillItems[selectedIndex] as TuiSkillSummary | undefined;
          if (skill) setSkills(host.skillMcpBridge?.setSkillEnabled(skill.skillId, skill.enabled === false) ?? []);
        } else {
          const server = mcpItems[selectedIndex] as TuiMcpServerSummary | undefined;
          if (server) setMcpServers(host.skillMcpBridge?.setMcpServerEnabled(server.id, !server.enabled) ?? []);
        }
        return;
      }
      if (skillSurface && (key.name === 'return' || key.name === 'enter')) {
        const skill = skillItems[selectedIndex] as TuiSkillSummary | undefined;
        if (!skill) return;
        const prompt = locale === 'zh-CN'
          ? `使用「${skill.name ?? skill.skillId}」技能处理此请求：`
          : `Use the ${skill.name ?? skill.skillId} Skill for this request: `;
        setExperience((current) => escapeFooter(current));
        if (key.shift) void controller.send(prompt);
        else {
          composerRef.current?.setText(prompt);
          setComposerDraft(prompt);
          queueMicrotask(() => composerRef.current?.focus());
        }
        return;
      }
      if (key.name === 'backspace') {
        setExperience((current) => current.surface.type === 'picker'
          ? { ...current, surface: { ...current.surface, query: current.surface.query.slice(0, -1), selectedIndex: 0 } }
          : current);
        return;
      }
      if (!key.ctrl && !key.meta && key.sequence.length === 1 && key.sequence >= ' ') {
        setExperience((current) => current.surface.type === 'picker'
          ? { ...current, surface: { ...current.surface, query: `${current.surface.query}${key.sequence}`, selectedIndex: 0 } }
          : current);
      }
      return;
    }
    if (commandSurface) {
      if (key.name === 'escape') {
        setExperience((current) => escapeFooter(current));
        return;
      }
      if (key.name === 'backspace') {
        setExperience((current) => updateCommandPanelQuery(current, commandSurface.query.slice(0, -1)));
        return;
      }
      if (!key.ctrl && !key.meta && key.sequence.length === 1 && key.sequence >= ' ') {
        setExperience((current) => updateCommandPanelQuery(current, `${commandSurface.query}${key.sequence}`));
        return;
      }
      if (key.name === 'up' || key.name === 'down') {
        const direction = key.name === 'up' ? -1 : 1;
        setExperience((current) => current.surface.type === 'picker' && current.surface.picker === 'command'
          ? {
              ...current,
              surface: {
                ...current.surface,
                selectedIndex: Math.max(0, Math.min(commandItems.length - 1, current.surface.selectedIndex + direction)),
              },
            }
          : current);
        return;
      }
      if ((key.name === 'return' || key.name === 'enter') && commandItems.length > 0) {
        const command = commandItems[commandSelection] ?? commandItems[0];
        if (!command) return;
        runCommand(command);
      }
      return;
    }
    if (activeSharedGoalPlan && goalRunner && !approval && snapshot.plan?.status !== 'awaiting_approval') {
      const planId = activeSharedGoalPlan.planId;
      const runnerStatus = activeSharedGoalPlan.runner?.status ?? activeSharedGoalPlan.status;
      if (key.name === 'p' && runnerStatus === 'running') {
        goalRunner.pause(planId);
        return;
      }
      if (key.name === 'r' && runnerStatus === 'paused') {
        void goalRunner.resume(planId);
        return;
      }
      if (key.name === 'c' && ['accepted', 'executing', 'running', 'paused'].includes(String(runnerStatus))) {
        controller.cancel();
        goalRunner.clear(planId);
        return;
      }
    }
    if (approval) {
      if (key.name === 'left' || key.name === 'up') {
        setApprovalSelection((current) => moveApprovalSelection(current, -1));
        return;
      }
      if (key.name === 'right' || key.name === 'down' || key.name === 'tab') {
        setApprovalSelection((current) => moveApprovalSelection(current, 1));
        return;
      }
      const decision = approvalDecisionForKey(key.name, approvalSelection);
      if (decision) approval.resolve(decision);
      return;
    }
    if (snapshot.plan?.status === 'awaiting_approval') {
      if (key.name === 'left' || key.name === 'up') {
        setPlanSelection((current) => movePlanSelection(current, -1));
        return;
      }
      if (key.name === 'right' || key.name === 'down' || key.name === 'tab') {
        setPlanSelection((current) => movePlanSelection(current, 1));
        return;
      }
      const decision = planDecisionForKey(key.name, planSelection);
      if (decision) void planCoordinator.decide(snapshot.plan.plan.planId, decision);
      return;
    }
    if (userInputSurface && pendingUserInput && pendingUserInput.options.length > 0) {
      if (key.name === 'left' || key.name === 'up') {
        setExperience((current) => ({
          ...current,
          surface: moveTuiSurfaceSelection(current.surface, -1, pendingUserInput.options.length),
        }));
        return;
      }
      if (key.name === 'right' || key.name === 'down' || key.name === 'tab') {
        setExperience((current) => ({
          ...current,
          surface: moveTuiSurfaceSelection(current.surface, 1, pendingUserInput.options.length),
        }));
        return;
      }
      // Free-text draft in composer takes priority over Enter option confirm.
      const draft = (composerRef.current?.plainText ?? composerDraft).trim();
      if ((key.name === 'return' || key.name === 'enter') && draft) {
        return;
      }
      const answer = userInputDecisionForKey(key.name, userInputSelection, pendingUserInput.options);
      if (answer) {
        setExperience((current) => escapeFooter(current));
        void controller.send(answer);
        return;
      }
      // Digits map to options; other keys fall through for free-text composer input.
      if (/^[1-9]$/.test(key.name)) return;
    }
    if (key.ctrl && key.name === 'c') {
      if (snapshot.status === 'running') controller.cancel();
      else onQuit();
      return;
    }
    if (snapshot.status !== 'idle') return;
    if ((key.ctrl && key.name === 'p') || (key.ctrl && key.name === 'k')) {
      setExperience((current) => openCommandPanel({ ...current, mode: snapshot.mode }));
    }
  });

  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      backgroundColor={COLOR.background}
    >
      {/* Session topbar spans conversation and Mission rail. */}
      {!isWelcome ? (
        <box
          flexDirection="column"
          width="100%"
          flexShrink={0}
          paddingTop={layout.outerPaddingY}
        >
          <box
            flexDirection="row"
            alignItems="center"
            flexShrink={0}
            height={1}
            paddingLeft={layout.outerPadding}
            paddingRight={layout.outerPadding}
            gap={1}
          >
            <text fg={COLOR.textSoft} wrapMode="none">
              <span fg={COLOR.accent}>{APP_CHROME.brandMark}</span>
              <strong> PEER</strong>
            </text>
            <text fg={COLOR.muted} wrapMode="none" flexShrink={1}>
              {sessionWorkspacePath}
            </text>
            <box flexGrow={1} minWidth={1} />
            <text fg={COLOR.muted} wrapMode="none">
              {sessionTopbarModel}
            </text>
            <text fg={COLOR.success} wrapMode="none">{APP_CHROME.onlineDot}</text>
          </box>
          <box marginLeft={layout.outerPadding} marginRight={layout.outerPadding} flexShrink={0}>
            <ComposerModeDivider width={topbarDividerWidth} />
          </box>
        </box>
      ) : null}
      {/* Split workspace starts below the full-width session topbar. */}
      <box
        flexDirection="row"
        width="100%"
        flexGrow={1}
        minHeight={0}
        paddingTop={isWelcome ? layout.outerPaddingY : 0}
        paddingBottom={layout.outerPaddingY}
      >
        <box flexDirection="column" flexGrow={1} minWidth={0} minHeight={0}>
      {isWelcome ? (
        <box flexGrow={1} flexDirection="column" justifyContent="center" alignItems="center" paddingLeft={layout.outerPadding} paddingRight={layout.outerPadding}>
          <box width="100%" flexDirection="column" alignItems="center" gap={2}>
            <box
              width="100%"
              position="relative"
              top={modelSurface
                ? -(welcomeModelVisibleRows + 2)
                : slashSurface
                  ? -Math.min(3, slashMaxVisible)
                  : 0}
              alignItems="center"
              justifyContent="center"
            >
              <B3Wordmark variant={wordmarkVariant} />
            </box>
            <box width={layout.welcomeWidth} maxWidth={112}>
              <ComposerDock
                controller={controller}
                snapshot={snapshot}
                disabled={false}
                focused={isComposerInputFocused}
                locale={locale}
                editorRef={composerRef}
          imagePathRegistry={imagePathRegistryRef.current}
                status={composerStatus}
                statusLayout={composerStatusLayout}
                layout={layout}
                draft={composerDraft}
                slashOpen={Boolean(slashSurface)}
                slashItems={slashItems}
                slashSelection={slashSelection}
                slashMaxVisible={Math.min(3, slashMaxVisible)}
                slashShowDescriptions={layout.showDescriptions}
                modelPickerOpen={Boolean(modelSurface)}
                modelPickerTitle={modelPickerView?.title ?? 'Model'}
                modelPickerSubtitle={modelPickerView?.subtitle}
                modelPickerGroups={modelPickerGroupLabels}
                modelPickerActiveGroup={modelPickerView?.activeGroup ?? null}
                modelPickerQuery={modelPickerQuery}
                modelPickerRows={modelPickerRows}
                modelPickerSelection={modelPickerSelection}
                modelPickerMaxVisible={welcomeModelMaxVisible}
                modelPickerShowHint={layout.showHints}
                onBeforeSend={() => setRenderWindowState(createConversationRenderWindowState())}
                onCommandInput={runSlashCommandInput}
                onValueChange={(value) => {
                  setComposerDraft(value);
                  setExperience((current) => syncSlashSuggestions(current, value));
                }}
              />
            </box>
          </box>
        </box>
      ) : (
        <>
          <box height={1} flexShrink={0} />
          <ChatHistory
            messages={renderProjection.messages}
            window={renderProjection.window}
            layout={layout}
          />

      {snapshot.error ? <ErrorBanner message={snapshot.error} layout={layout} /> : null}

      {snapshot.plan?.status === 'awaiting_approval' ? (
        <box flexDirection="column" border borderStyle="rounded" borderColor={COLOR.user} padding={1} backgroundColor={COLOR.panel} marginLeft={layout.outerPadding} marginRight={layout.outerPadding}>
          <text fg={COLOR.user}><strong>Plan approval</strong> · {snapshot.plan.plan.title}</text>
          <text fg={COLOR.text}>{snapshot.plan.plan.goal}</text>
          {snapshot.plan.plan.tasks.map((task, index) => (
            <text key={task.taskId} fg={COLOR.muted}>{index + 1}. {task.title}</text>
          ))}
          <box flexDirection={layout.stackActions ? 'column' : 'row'} gap={layout.stackActions ? 0 : 2}>
            {PLAN_APPROVAL_OPTIONS.map((option, index) => {
              const selected = index === planSelection;
              return (
                <box
                  key={option.decision}
                  backgroundColor={PICKER_CHROME.idleBackground}
                  paddingLeft={selected ? 0 : 0}
                >
                  <text fg={selected ? option.color : COLOR.muted}>
                    {selected ? PICKER_CHROME.caretSelected : PICKER_CHROME.caretIdle}
                    [{option.shortcut}] {option.label}
                  </text>
                </box>
              );
            })}
          </box>
          {layout.showHints ? <text fg={COLOR.muted}>←/→ or Tab select · Enter confirm · Esc Reject</text> : null}
        </box>
      ) : null}

      {goalView && goalLayout.mode === 'compact-summary' ? (
        <box flexShrink={0} marginLeft={layout.outerPadding} marginRight={layout.outerPadding}>
          <GoalCompactSummary
            view={goalView}
            missionPosition={missionPosition}
            totalPlans={sharedGoalPlans.length}
            onOpenHistory={openGoalHistory}
          />
        </box>
      ) : null}


      {pendingUserInput && userInputSurface && pendingUserInput.options.length > 0 ? (
        <box
          flexDirection="column"
          flexShrink={0}
          border={['top']}
          borderColor={PICKER_CHROME.border}
          paddingTop={1}
          backgroundColor={PICKER_CHROME.idleBackground}
          marginLeft={layout.outerPadding}
          marginRight={layout.outerPadding}
        >
          <text fg={COLOR.accent}><strong>Ask user</strong></text>
          <text fg={COLOR.text}>{pendingUserInput.question}</text>
          <box flexDirection="column" gap={0} flexShrink={0}>
            {userInputOptions.map((option, index) => {
              const selected = index === userInputSelection;
              return (
                <box
                  key={`${option.shortcut}-${option.label}`}
                  backgroundColor={PICKER_CHROME.idleBackground}
                >
                  <text fg={selected ? option.color : COLOR.muted}>
                    {selected ? PICKER_CHROME.caretSelected : PICKER_CHROME.caretIdle}
                    [{option.shortcut}] {option.label}
                  </text>
                </box>
              );
            })}
          </box>
          <text fg={COLOR.muted}>↑↓ select · Enter confirm · type free text below</text>
        </box>
      ) : null}

      {approval ? (() => {
        const details = approvalCardDetails(approval.prompt);
        return (
          <box flexDirection="column" border borderStyle="rounded" borderColor={COLOR.danger} paddingLeft={1} paddingRight={1} flexShrink={0} backgroundColor={COLOR.panel} marginLeft={layout.outerPadding} marginRight={layout.outerPadding}>
            <text fg={COLOR.dangerSoft} wrapMode="none"><strong>Approval required</strong></text>
            <text fg={COLOR.dangerSoft} wrapMode="none">Action  {details.action}</text>
            <text fg={COLOR.muted} wrapMode="none">Where   {details.location}</text>
            <text fg={COLOR.muted} wrapMode="none">Reason  {details.reason}</text>
            <text fg={COLOR.warning} wrapMode="none">Risk    {details.risk}</text>
            <text fg={COLOR.textSoft} wrapMode="none">Args    {details.arguments}</text>
            <box flexDirection="column" gap={0} flexShrink={0}>
              {TUI_APPROVAL_OPTIONS.map((option, index) => {
                const selected = index === approvalSelection;
                return (
                  <box
                    key={option.decision}
                    backgroundColor={PICKER_CHROME.idleBackground}
                  >
                    <text fg={selected ? option.color : COLOR.muted}>
                      {selected ? PICKER_CHROME.caretSelected : PICKER_CHROME.caretIdle}
                      {option.shortcut}. {option.label}
                    </text>
                  </box>
                );
              })}
            </box>
            {layout.showHints ? <text fg={COLOR.muted}>↑/↓ select  ·  Enter confirm  ·  Esc deny</text> : null}
          </box>
        );
      })() : null}

      {commandNotice && !commandSurface ? (
        <box
          flexShrink={0}
          width="100%"
          paddingLeft={layout.outerPadding}
          paddingRight={layout.outerPadding}
        >
          <text fg={COLOR.accent}>{commandNotice}</text>
        </box>
      ) : null}

      {permissionSurface ? (
        <box
          flexDirection="column"
          height={pickerLayout.modePanelRows}
          flexShrink={0}
          border={['top']}
          borderColor={PICKER_CHROME.border}
          backgroundColor={PICKER_CHROME.idleBackground}
          paddingTop={pickerLayout.verticalPadding}
          paddingBottom={pickerLayout.verticalPadding}
        >
          <text fg={COLOR.text} wrapMode="none"><strong>Local access</strong></text>
          {TUI_PERMISSION_POLICIES.map((option, index) => {
            const selected = index === permissionSelection;
            return (
              <box
                key={option.policy}
                flexDirection="column"
                flexShrink={0}
                backgroundColor={PICKER_CHROME.idleBackground}
              >
                <text fg={selected ? PICKER_CHROME.selectedForeground : PICKER_CHROME.idleForeground} wrapMode="none">
                  {selected ? PICKER_CHROME.caretSelected : PICKER_CHROME.caretIdle}
                  {option.shortcut}. {option.label}
                  {option.policy === accessLevel ? PICKER_CHROME.checkCurrent : ''}
                </text>
                {pickerLayout.showDescriptions ? <text fg={COLOR.muted} wrapMode="none">   {option.description}</text> : null}
              </box>
            );
          })}
          {pickerLayout.showContext ? (
            <text fg={COLOR.muted} wrapMode="none">Runtime deny rules and irreversible-action gates always win.</text>
          ) : null}
          {pickerLayout.showHints ? (
            <text fg={COLOR.muted} wrapMode="none">↑↓ select  ·  1–3 choose  ·  enter apply  ·  esc close</text>
          ) : null}
        </box>
      ) : null}

      {resumeSurface ? (
        <ResumePickerMenu
          rows={resumeItems}
          selectedIndex={resumeSurface.selectedIndex}
          maxVisible={Math.min(8, pickerLayout.commandMaxVisible)}
          onResume={handleResumeConversationSummary}
        />
      ) : null}

      {goalSurface ? (
        <GoalPlanPicker
          plans={goalPickerPlans}
          selectedIndex={goalPickerSelection}
          currentPlanId={selectedGoalPlanId}
          query={goalSurface.query}
          maxVisible={Math.min(8, pickerLayout.commandMaxVisible)}
          onSelect={selectGoalFromHistory}
        />
      ) : null}

            {languageSurface ? (
        <box
          flexDirection="column"
          height={pickerLayout.modePanelRows}
          flexShrink={0}
          border={['top']}
          borderColor={PICKER_CHROME.border}
          backgroundColor={PICKER_CHROME.idleBackground}
          paddingTop={pickerLayout.verticalPadding}
          paddingBottom={pickerLayout.verticalPadding}
        >
          <text fg={COLOR.text} wrapMode="none"><strong>{locale === 'zh-CN' ? '语言' : 'Language'}</strong></text>
          {pickerLayout.showDescriptions ? (
            <text fg={COLOR.muted} wrapMode="none">
              {locale === 'zh-CN' ? '同时切换界面语言与模型回复语言' : 'Switch UI language and model reply language together'}
            </text>
          ) : null}
          {TUI_LANGUAGE_OPTIONS.map((option, index) => {
            const selected = index === languageSelection;
            return (
              <box
                key={option.locale}
                flexDirection="row"
                backgroundColor={PICKER_CHROME.idleBackground}
              >
                <text fg={selected ? PICKER_CHROME.selectedForeground : PICKER_CHROME.idleForeground} wrapMode="none">
                  {selected ? PICKER_CHROME.caretSelected : PICKER_CHROME.caretIdle}
                  {option.shortcut}. {option.label}
                  {option.locale === locale ? PICKER_CHROME.checkCurrent : ''}
                </text>
              </box>
            );
          })}
          {pickerLayout.showDescriptions ? (
            <text fg={COLOR.muted} wrapMode="word">
              {TUI_LANGUAGE_OPTIONS[languageSelection]?.description ?? ''}
            </text>
          ) : null}
        </box>
      ) : null}

      {themeSurface ? (
        <box
          flexDirection="column"
          height={pickerLayout.modePanelRows}
          flexShrink={0}
          border={['top']}
          borderColor={PICKER_CHROME.border}
          backgroundColor={PICKER_CHROME.idleBackground}
          paddingTop={pickerLayout.verticalPadding}
          paddingBottom={pickerLayout.verticalPadding}
        >
          <text fg={COLOR.text} wrapMode="none">
            <strong>{tuiMessage(locale, 'picker.theme.title')}</strong>
          </text>
          {pickerLayout.showDescriptions ? (
            <text fg={COLOR.muted} wrapMode="none">
              {tuiMessage(locale, 'picker.theme.description')}
            </text>
          ) : null}
          {TUI_THEME_OPTIONS.map((option, index) => {
            const selected = index === themeSelection;
            const label = locale === 'zh-CN' ? option.labelZh : option.labelEn;
            return (
              <box
                key={option.mode}
                flexDirection="row"
                backgroundColor={PICKER_CHROME.idleBackground}
              >
                <text fg={selected ? PICKER_CHROME.selectedForeground : PICKER_CHROME.idleForeground} wrapMode="none">
                  {selected ? PICKER_CHROME.caretSelected : PICKER_CHROME.caretIdle}
                  {index + 1}. {label}
                  {option.mode === themeMode ? PICKER_CHROME.checkCurrent : ''}
                </text>
              </box>
            );
          })}
          {pickerLayout.showHints ? (
            <text fg={COLOR.muted} wrapMode="none">
              {tuiMessage(locale, 'picker.theme.hint')}
            </text>
          ) : null}
        </box>
      ) : null}

      {modeSurface ? (
        <box
          flexDirection="column"
          height={pickerLayout.modePanelRows}
          flexShrink={0}
          border={['top']}
          borderColor={PICKER_CHROME.border}
          backgroundColor={PICKER_CHROME.idleBackground}
          paddingTop={pickerLayout.verticalPadding}
          paddingBottom={pickerLayout.verticalPadding}
        >
          <text fg={COLOR.accent} wrapMode="none"><strong>Mode</strong></text>
          {pickerLayout.showContext ? (
            activeTurnMode && activeTurnMode !== snapshot.mode ? (
              <text fg={COLOR.muted} wrapMode="none">
                Current turn: {tuiModeOption(activeTurnMode).label} · Next message: {tuiModeOption(snapshot.mode).label}
              </text>
            ) : (
              <text fg={COLOR.muted} wrapMode="none">Choose how the next message should run</text>
            )
          ) : null}
          {TUI_MODES.map((option, index) => {
            const selected = index === modeSelection;
            return (
              <box
                key={option.mode}
                flexDirection="column"
                flexShrink={0}
                backgroundColor={PICKER_CHROME.idleBackground}
              >
                <text fg={selected ? PICKER_CHROME.selectedForeground : PICKER_CHROME.idleForeground} wrapMode="none">
                  {selected ? PICKER_CHROME.caretSelected : PICKER_CHROME.caretIdle}
                  [{option.shortcut}] {option.label}
                  {snapshot.mode === option.mode ? PICKER_CHROME.checkCurrent : ''}
                </text>
                {pickerLayout.showDescriptions ? <text fg={COLOR.muted} wrapMode="none">    {option.description}</text> : null}
              </box>
            );
          })}
          {pickerLayout.showHints ? (
            <text fg={COLOR.muted} wrapMode="none">↑↓ select · 1–3 direct · enter confirm · esc close</text>
          ) : null}
        </box>
      ) : null}

      {helpSurface ? (
        <box
          flexDirection="column"
          flexShrink={0}
          border={['top']}
          borderColor={PICKER_CHROME.border}
          backgroundColor={PICKER_CHROME.idleBackground}
          paddingTop={pickerLayout.verticalPadding}
          paddingBottom={pickerLayout.verticalPadding}
        >
          <text fg={COLOR.text} wrapMode="none"><strong>Help</strong></text>
          <text fg={COLOR.muted} wrapMode="none">Shortcuts, commands, and modes for this TUI</text>
          {helpSections.map((section) => (
            <box key={section.title} flexDirection="column" marginTop={1}>
              <text fg={COLOR.accent} wrapMode="none"><strong>{section.title}</strong></text>
              {section.lines.map((line) => (
                <text key={`${section.title}:${line}`} fg={COLOR.muted} wrapMode="none">  {line}</text>
              ))}
            </box>
          ))}
          {pickerLayout.showHints ? (
            <text fg={COLOR.muted} wrapMode="none">enter / esc close</text>
          ) : null}
        </box>
      ) : null}

      {skillSurface || mcpSurface ? (
        <box
          position="absolute"
          width="100%"
          height="100%"
          justifyContent="center"
          alignItems="center"
          backgroundColor={COLOR.background}
        >
          <box width={Math.min(76, Math.max(44, terminal.width - 6))} maxHeight={Math.max(12, terminal.height - 6)} flexDirection="column" border borderStyle="rounded" borderColor={COLOR.accent} backgroundColor={COLOR.panel} paddingLeft={1} paddingRight={1}>
            <text fg={COLOR.text}><b>{skillSurface ? tuiMessage(locale, 'picker.skill.title') : tuiMessage(locale, 'picker.mcp.title')}</b></text>
            <text fg={COLOR.muted}>{skillSurface ? tuiMessage(locale, 'picker.skill.hint') : tuiMessage(locale, 'picker.mcp.hint')}</text>
            {(skillSurface ? skillItems : mcpItems).map((item, index) => {
              const selected = index === (skillSurface ?? mcpSurface)!.selectedIndex;
              if (skillSurface) {
                const skill = item as TuiSkillSummary;
                return <box key={skill.skillId} flexDirection="column" backgroundColor={selected ? COLOR.selection : undefined} paddingLeft={1}>
                  <text fg={skill.enabled === false ? COLOR.muted : COLOR.text}>{selected ? PICKER_CHROME.caretSelected : PICKER_CHROME.caretIdle}{skill.enabled === false ? APP_CHROME.offlineDot : APP_CHROME.onlineDot} {skill.name ?? skill.skillId}</text>
                  <text fg={COLOR.muted} wrapMode="none">  {skill.description ?? skill.skillId}</text>
                </box>;
              }
              const server = item as TuiMcpServerSummary;
              return <box key={server.id} flexDirection="column" backgroundColor={selected ? COLOR.selection : undefined} paddingLeft={1}>
                <text fg={server.enabled ? COLOR.text : COLOR.muted}>{selected ? PICKER_CHROME.caretSelected : PICKER_CHROME.caretIdle}{server.enabled ? APP_CHROME.onlineDot : APP_CHROME.offlineDot} {server.displayName}</text>
                <text fg={COLOR.muted} wrapMode="none">  {server.health?.status ?? tuiMessage(locale, 'mcp.status.unknown')} · {server.visibleToolsCount}/{server.toolsCount} {tuiMessage(locale, 'mcp.status.tools')} · {server.tools.map((tool) => tool.name ?? tool.toolName).filter(Boolean).join(', ') || tuiMessage(locale, 'mcp.status.noTools')}</text>
              </box>;
            })}
            {(skillSurface ? skillItems : mcpItems).length === 0 ? <text fg={COLOR.muted}>{tuiMessage(locale, 'picker.skillmcp.empty')}</text> : null}
            <text fg={COLOR.muted}>{tuiMessage(locale, 'picker.skillmcp.searchLabel')} {(skillSurface ?? mcpSurface)!.query || tuiMessage(locale, 'picker.skillmcp.searchPlaceholder')}</text>
          </box>
        </box>
      ) : null}

      {commandSurface ? (
        <box
          flexDirection="column"
          flexShrink={0}
          border={['top']}
          borderColor={PICKER_CHROME.border}
          backgroundColor={PICKER_CHROME.idleBackground}
          paddingTop={pickerLayout.verticalPadding}
          paddingBottom={pickerLayout.verticalPadding}
        >
          <text fg={PICKER_CHROME.title} wrapMode="none"><strong>Commands</strong></text>
          {pickerLayout.showContext ? (
            <text fg={COLOR.muted} wrapMode="none">{commandSurface.query ? `Search: ${commandSurface.query}` : 'Type to search commands'}</text>
          ) : null}
          {commandWindow.map(({ command, index }) => {
            const selected = index === commandSelection;
            return (
              <box
                key={command.id}
                flexDirection="column"
                flexShrink={0}
                backgroundColor={PICKER_CHROME.idleBackground}
              >
                <text fg={selected ? PICKER_CHROME.selectedForeground : PICKER_CHROME.idleForeground} wrapMode="none">
                  {selected ? PICKER_CHROME.caretSelected : PICKER_CHROME.caretIdle}{command.label}
                </text>
                {pickerLayout.showDescriptions ? <text fg={COLOR.muted} wrapMode="none">{command.description}</text> : null}
              </box>
            );
          })}
          {pickerLayout.showHints ? (
            <text fg={COLOR.muted} wrapMode="none">↑↓ select  ·  enter run  ·  esc close</text>
          ) : null}
        </box>
      ) : (
        <ComposerDock
          controller={controller}
          snapshot={snapshot}
          disabled={Boolean(approval) || snapshot.plan?.status === 'awaiting_approval'}
          focused={isComposerInputFocused}
          locale={locale}
          editorRef={composerRef}
          imagePathRegistry={imagePathRegistryRef.current}
          status={composerStatus}
          statusLayout={composerStatusLayout}
          layout={layout}
          draft={composerDraft}
          slashOpen={Boolean(slashSurface)}
          slashItems={slashItems}
          slashSelection={slashSelection}
          slashMaxVisible={slashMaxVisible}
          slashShowDescriptions={layout.showDescriptions}
          modelPickerOpen={Boolean(modelSurface)}
          modelPickerTitle={modelPickerView?.title ?? 'Model'}
          modelPickerSubtitle={modelPickerView?.subtitle}
          modelPickerGroups={modelPickerGroupLabels}
          modelPickerActiveGroup={modelPickerView?.activeGroup ?? null}
          modelPickerQuery={modelPickerQuery}
          modelPickerRows={modelPickerRows}
          modelPickerSelection={modelPickerSelection}
          modelPickerMaxVisible={slashMaxVisible}
          modelPickerShowHint={layout.showHints}
          onBeforeSend={() => setRenderWindowState(createConversationRenderWindowState())}
          onCommandInput={runSlashCommandInput}
          onValueChange={(value) => {
            setComposerDraft(value);
            setExperience((current) => syncSlashSuggestions(current, value));
          }}
        />
      )}
        </>
      )}
        </box>
        {!isWelcome && goalView && goalLayout.mode === 'side-panel' ? (
          <GoalStatusPanel
            view={goalView}
            width={goalLayout.panelWidth}
            missionPosition={missionPosition}
            totalPlans={sharedGoalPlans.length}
            onOpenHistory={openGoalHistory}
          />
        ) : null}
      </box>
    </box>
  );
}
