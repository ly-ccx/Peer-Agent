import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { TextareaRenderable } from '@opentui/core';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import type { LocalAccessLevel } from '@peer-agent/protocol';
import type { RuntimeGoalSnapshot } from '@peer-agent/runtime-sdk';
import type { RuntimeModelSelection } from '@peer-agent/runtime-node';

import { B3Wordmark } from './b3-wordmark-view.tsx';
import { MarkdownView } from './markdown-view.tsx';
import { buildTuiHelpSections } from './command-registry.ts';
import { executeTuiCommand } from './command-execution.ts';
import {
  createTuiConversationPersistence,
  resumeTuiConversation,
  type TuiConversationSummary,
} from './conversation-persistence.ts';
import {
  ComposerControlsBar,
  ComposerStatusBar,
  type ComposerStatusLayout,
} from './composer-status-view.tsx';
import { createComposerStatus, type ComposerStatus } from './composer-status.ts';
import {
  createChatController,
  type ChatController,
  type ChatModelPort,
  type ChatSnapshot,
} from './chat-controller.ts';
import {
  isSlashCommandInput,
  loadLocalImageAttachments,
} from './composer-image-paths.ts';
import {
  approvalCardDetails,
  approvalDecisionForKey,
  moveApprovalSelection,
  TUI_APPROVAL_OPTIONS,
} from './approval-card.ts';
import {
  createPlanCoordinator,
  movePlanSelection,
  PLAN_APPROVAL_OPTIONS,
  planDecisionForKey,
} from './plan-mode.ts';
import { createTuiGoalRunner } from './goal-mode.ts';
import {
  buildModelPickerView,
  cycleModelPickerGroup,
  formatModelPickerGroupLabel,
  indexOfCurrentSelectableRow,
  modelPickerGroupCounts,
  modelSelectionLabel,
  type ModelPickerStage,
  type ModelPickerViewRow,
  type TuiModelSelectionControl,
} from './tui-model-selection.ts';
import type { PendingApproval, TuiHost } from './tui-host.ts';
import { TUI_MODES, tuiModeOption, type TuiMode } from './tui-mode.ts';
import {
  permissionPolicyForKey,
  permissionPolicyIndex,
  permissionPolicyLabels,
  TUI_PERMISSION_POLICIES,
} from './tui-permission-policy.ts';
import { moveTuiSurfaceSelection } from './surface-state.ts';
import { composerEnterAction, runtimeControlAction } from './runtime-controls.ts';
import { responsiveLayout, responsivePickerLayout } from './responsive-layout.ts';
import {
  resolveToolPresentation,
  toolHeadline,
  toolStatusGlyph,
  toggleToolDetails,
} from './tool-result-summary.ts';
import {
  applyTuiCommand,
  createTuiExperienceState,
  escapeFooter,
  filterTuiCommands,
  openCommandPanel,
  selectionWindow,
  slashCommandWindow,
  syncSlashSuggestions,
  type TuiCommand,
  type TuiExperienceState,
  updateCommandPanelQuery,
} from './tui-experience.ts';
import {
  COLOR,
  PICKER_CHROME,
  TOOL_CHROME,
  toolStatusColor,
} from './tui-theme.ts';

const COMMAND_NOTICE_DURATION_MS = 3_000;

function ChatHistory({ snapshot }: { readonly snapshot: ChatSnapshot }) {
  const [expandedTools, setExpandedTools] = useState<ReadonlySet<string>>(new Set());

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
      paddingLeft={2}
      paddingRight={2}
    >
      {snapshot.messages.map((message) => {
        if (message.role === 'system') {
          const phase = message.compact?.phase ?? 'done';
          const label = phase === 'progress' ? 'COMPACTING' : 'COMPACTED';
          return (
            <box key={message.id} flexDirection="column" marginBottom={1} marginTop={1}>
              <box flexDirection="row">
                <text fg={COLOR.muted}>{'─'.repeat(8)} </text>
                <text fg={COLOR.accent}><strong>{label}</strong></text>
                <text fg={COLOR.muted}> {'─'.repeat(8)}</text>
              </box>
              <text fg={COLOR.muted}>{message.content || ' '}</text>
            </box>
          );
        }

        if (message.role === 'assistant') {
          return (
            <box key={message.id} flexDirection="column" marginBottom={1}>
              {message.pending && !message.content ? (
                <text fg={COLOR.muted}>thinking…</text>
              ) : (
                <MarkdownView content={message.content || ' '} />
              )}
            </box>
          );
        }

        if (message.role === 'user') {
          return (
            <box key={message.id} flexDirection="row" marginBottom={1}>
              <text fg={COLOR.user}><strong>› </strong></text>
              <text fg={COLOR.text}>{message.content || ' '}</text>
            </box>
          );
        }

        const toolExpanded = expandedTools.has(message.id);
        const presentation = resolveToolPresentation(message);
        const headlineColor = toolStatusColor(presentation.status);
        const detailColor = presentation.status === 'failed' || presentation.status === 'denied'
          ? COLOR.toolFailed
          : COLOR.toolDetail;
        const detailLines = toolExpanded
          ? presentation.detail.split(/\r?\n/).filter((line) => line.trim().length > 0)
          : presentation.detailLines;
        return (
          <box
            key={message.id}
            flexDirection="column"
            marginBottom={1}
            onMouseDown={() => toggleTool(message.id)}
          >
            <box flexDirection="row">
              <text fg={headlineColor} wrapMode="none">
                {toolStatusGlyph(presentation.status)}{' '}
              </text>
              <text fg={headlineColor} wrapMode="none">
                <strong>{toolHeadline(presentation.toolName, presentation.argumentSummary)}</strong>
              </text>
            </box>
            {detailLines.map((line, index) => (
              <box key={`${message.id}-detail-${index}`} flexDirection="row">
                <text fg={COLOR.subtle} wrapMode="none">
                  {index === 0 ? TOOL_CHROME.branchFirst : TOOL_CHROME.branchRest}
                </text>
                <text fg={detailColor}>{line || ' '}</text>
              </box>
            ))}
          </box>
        );
      })}
    </scrollbox>
  );
}

function ErrorBanner({ message }: { readonly message: string }) {
  return (
    <box height={1} flexShrink={0} paddingLeft={2} paddingRight={2}>
      <text fg={COLOR.dangerSoft} wrapMode="none">Error: {message}</text>
    </box>
  );
}

function SlashCommandMenu({ commands, selectedIndex, maxVisible, showDescriptions }: {
  readonly commands: readonly TuiCommand[];
  readonly selectedIndex: number;
  readonly maxVisible: number;
  readonly showDescriptions: boolean;
}) {
  const visibleCommands = slashCommandWindow(commands, selectedIndex, maxVisible);

  return (
    <box
      position="absolute"
      left={0}
      right={0}
      bottom={5}
      zIndex={100}
      flexDirection="column"
      border
      borderColor={COLOR.border}
      backgroundColor={COLOR.panel}
      paddingLeft={1}
      paddingRight={1}
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
            backgroundColor={selected ? PICKER_CHROME.selectedBackground : PICKER_CHROME.idleBackground}
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

function ResumePickerMenu({ rows, selectedIndex, maxVisible }: {
  readonly rows: readonly TuiConversationSummary[];
  readonly selectedIndex: number;
  readonly maxVisible: number;
}) {
  const visibleRows = selectionWindow(rows, selectedIndex, maxVisible);
  return (
    <box flexDirection="column" flexShrink={0} border borderColor={COLOR.border} backgroundColor={COLOR.panel} paddingLeft={1} paddingRight={1}>
      <text fg={COLOR.accent} wrapMode="none"><strong>Resume session</strong></text>
      {rows.length === 0 ? <text fg={COLOR.muted}>No saved conversations to resume.</text> : visibleRows.map(({ item: row, index }) => {
        const selected = index === selectedIndex;
        return (
          <box
            key={row.id}
            flexDirection="row"
            height={1}
            backgroundColor={selected ? PICKER_CHROME.selectedBackground : PICKER_CHROME.idleBackground}
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
      bottom={5}
      zIndex={100}
      flexDirection="column"
      border
      borderColor={COLOR.border}
      backgroundColor={COLOR.panel}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={COLOR.accent} wrapMode="none"><strong>{title}</strong>{subtitle ? ` · ${subtitle}` : ''}</text>
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

function Composer({ controller, snapshot, disabled, focused, onValueChange, editorRef }: {
  readonly controller: ChatController;
  readonly snapshot: ChatSnapshot;
  readonly disabled: boolean;
  readonly focused: boolean;
  readonly onValueChange: (value: string) => void;
  readonly editorRef: RefObject<TextareaRenderable | null>;
}) {
  const editor = editorRef;

  const submit = () => {
    const value = editor.current?.plainText ?? '';
    const trimmed = value.trim();
    if (!trimmed || isSlashCommandInput(trimmed) || disabled || snapshot.status !== 'idle') return;
    editor.current?.clear();
    void (async () => {
      const attachment = await loadLocalImageAttachments(value);
      const text = attachment.text || attachment.displayContent;
      if (!text.trim() && attachment.images.length === 0) return;
      void controller.send(text, attachment.images.length > 0 ? { images: attachment.images } : undefined);
    })();
  };

  return (
    <box flexDirection="column" border borderStyle="rounded" borderColor={snapshot.status === 'idle' ? COLOR.border : COLOR.accent} height={5} paddingLeft={1} paddingRight={1} backgroundColor={COLOR.panel}>
      <textarea
        ref={editor}
        focused={focused && !disabled}
        placeholder={disabled ? 'Resolve the request above…' : 'Ask anything…'}
        wrapMode="word"
        onContentChange={() => onValueChange(editor.current?.plainText ?? '')}
        onKeyDown={(event) => {
          const action = composerEnterAction({
            keyName: event.name,
            shift: event.shift,
            eventType: event.eventType,
          });
          if (action === 'none' || action === 'newline') return;
          event.preventDefault();
          event.stopPropagation();
          if (action === 'submit') submit();
        }}
      />
    </box>
  );
}

function ComposerDock({
  controller,
  snapshot,
  disabled,
  onValueChange,
  editorRef,
  status,
  statusLayout,
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
  readonly onValueChange: (value: string) => void;
  readonly editorRef: RefObject<TextareaRenderable | null>;
  readonly status: ComposerStatus;
  readonly statusLayout: ComposerStatusLayout;
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
    ? Math.min(slashMaxVisible, Math.max(1, slashItems.length)) + 2
    : modelPickerOpen
      // groups + search + optional hint around the visible rows
      ? Math.min(modelPickerMaxVisible, Math.max(1, modelPickerRows.length)) + 4
      : 0;

  return (
    <box flexDirection="column" flexShrink={0} width="100%" paddingTop={menuReserve}>
      {/* controls above the input; status below */}
      <ComposerControlsBar status={status} layout={statusLayout} />
      <box position="relative" width="100%" height={5} overflow="visible">
        {slashOpen ? (
          <SlashCommandMenu
            commands={slashItems}
            selectedIndex={slashSelection}
            maxVisible={slashMaxVisible}
            showDescriptions={slashShowDescriptions}
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
          />
        ) : null}
        <Composer
          controller={controller}
          snapshot={snapshot}
          disabled={disabled}
          focused={!modelPickerOpen}
          onValueChange={onValueChange}
          editorRef={editorRef}
        />
      </box>
      <ComposerStatusBar status={status} layout={statusLayout} />
    </box>
  );
}

export function App({ host, model, modelLabel, modelSelection, onQuit }: {
  readonly host: TuiHost;
  readonly model: ChatModelPort;
  readonly modelLabel: string;
  readonly modelSelection?: TuiModelSelectionControl;
  readonly onQuit: () => void;
}) {
  const terminal = useTerminalDimensions();
  const controllerRef = useRef<ChatController | null>(null);
  const composerRef = useRef<TextareaRenderable | null>(null);
  const goalRunner = useMemo(() => createTuiGoalRunner({
    sessionId: 'tui-chat',
    executeTask: async (task, context) => {
      const active = controllerRef.current;
      if (!active) return { status: 'blocked', reason: 'chat_controller_unavailable' };
      return active.executeGoalTask(task, context);
    },
  }), []);
  const planCoordinator = useMemo(() => createPlanCoordinator({
    sessionId: 'tui-chat',
    goalExecution: {
      create: async ({ plan }) => {
        const goal = goalRunner.create(plan);
        void goalRunner.start(goal.goalId);
      },
    },
  }), [goalRunner]);
  const controller = useMemo(
    () => createChatController({ host, model, planCoordinator }),
    [host, model, planCoordinator],
  );
  controllerRef.current = controller;
  const [snapshot, setSnapshot] = useState(() => controller.getSnapshot());
  const [goal, setGoal] = useState<RuntimeGoalSnapshot | null>(null);
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const [approvalSelection, setApprovalSelection] = useState(0);
  const [planSelection, setPlanSelection] = useState(0);
  const [commandNotice, setCommandNotice] = useState<string | null>(null);
  const [resumeItems, setResumeItems] = useState<readonly TuiConversationSummary[]>([]);
  const [selectedModel, setSelectedModel] = useState<RuntimeModelSelection | null>(
    () => modelSelection?.getSelection() ?? null,
  );
  const [modelPickerQuery, setModelPickerQuery] = useState('');
  const [modelPickerStage, setModelPickerStage] = useState<ModelPickerStage>('models');
  const [modelPickerGroup, setModelPickerGroup] = useState<string | null>(null);
  const [modelPickerPending, setModelPickerPending] = useState<{
    readonly providerId: string;
    readonly modelId: string;
  } | null>(null);
  const persistence = useMemo(() => createTuiConversationPersistence({
    workspacePath: process.cwd(),
    initialMode: controller.getSnapshot().mode,
    initialModel: modelSelection?.getSelection() ?? {
      providerId: 'unknown',
      modelId: modelLabel,
      reasoningEffort: 'default',
    },
  }), [controller, modelLabel, modelSelection]);
  const [accessLevel, setAccessLevel] = useState<LocalAccessLevel>(() => host.getAccessLevel());
  const [composerDraft, setComposerDraft] = useState('');
  const [experience, setExperience] = useState<TuiExperienceState>(() => createTuiExperienceState());
  const visibleTurn = snapshot.session?.activeTurn ?? snapshot.session?.lastTurn;
  const commandSurface = experience.surface.type === 'picker' && experience.surface.picker === 'command'
    ? experience.surface
    : null;
  const slashSurface = experience.surface.type === 'slash-suggestions'
    ? experience.surface
    : null;
  const goalStatus = goal?.status === 'paused'
    ? 'paused'
    : goal && ['pending', 'running'].includes(goal.status)
      ? 'running'
      : 'none';
  const commandItems = commandSurface
    ? filterTuiCommands(commandSurface.query, { goalStatus })
    : [];
  const slashItems = slashSurface
    ? filterTuiCommands(slashSurface.query, { goalStatus })
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
    () => (helpSurface ? buildTuiHelpSections({ goalStatus }) : []),
    [goalStatus, helpSurface],
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
  const permissionSelection = permissionSurface?.selectedIndex ?? permissionPolicyIndex(accessLevel);
  const activeTurnMode = snapshot.activeTurnMode;
  const selectedModelLabel = selectedModel && modelSelection
    ? modelSelectionLabel(modelSelection, selectedModel)
    : modelLabel;
  const contextWindow = modelSelection?.catalog.find(
    (entry) => entry.providerId === selectedModel?.providerId
      && entry.modelId === selectedModel?.modelId,
  )?.contextWindow;
  const composerStatus = createComposerStatus({
    workspaceRoot: host.workspaceRoot,
    mode: snapshot.mode,
    accessLevel,
    modelLabel: selectedModelLabel,
    reasoningEffort: selectedModel?.reasoningEffort,
    usage: snapshot.usage,
    contextWindow,
  });
  const layout = responsiveLayout(terminal.width);
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
  const isComposerSurface = experience.surface.type === 'composer'
    || experience.surface.type === 'slash-suggestions'
    || Boolean(modelSurface);
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

  const isWelcome = snapshot.messages.length === 0
    && !approval
    && snapshot.plan?.status !== 'awaiting_approval'
    && !goal
    && !snapshot.error
    && isComposerSurface;

  useEffect(() => controller.subscribe((next) => {
    persistence.syncSnapshot(next);
    setSnapshot(next);
  }), [controller, persistence]);
  useEffect(() => goalRunner.subscribe(setGoal), [goalRunner]);
  useEffect(() => host.subscribeApproval((next) => {
    setApprovalSelection(0);
    setApproval(next);
  }), [host]);

  const selectMode = (mode: TuiMode) => {
    controller.setMode(mode);
    setExperience((current) => escapeFooter({ ...current, mode }));
    setCommandNotice(
      activeTurnMode && activeTurnMode !== mode
        ? `${tuiModeOption(mode).label} selected for the next message · current turn remains ${tuiModeOption(activeTurnMode).label}`
        : `${tuiModeOption(mode).label} mode selected`,
    );
    queueMicrotask(() => composerRef.current?.focus());
  };

  const runCommand = (command: TuiCommand) => executeTuiCommand(command, {
    clearChat: () => {
      const cleared = controller.clear();
      if (cleared) persistence.startNewConversation(controller.getSnapshot().mode);
      return cleared;
    },
    compactContext: async () => (await controller.compact()).notice,
    controlGoal: (control) => {
      if (!goal) return 'No active goal';
      if (control === 'pause' && goal.status === 'running') {
        goalRunner.pause(goal.goalId);
        return 'Goal paused';
      }
      if (control === 'resume' && goal.status === 'paused') {
        void goalRunner.resume(goal.goalId);
        return 'Goal resumed';
      }
      if (control === 'cancel' && ['pending', 'running', 'paused'].includes(goal.status)) {
        controller.cancel();
        goalRunner.cancel(goal.goalId);
        return 'Goal cancelled';
      }
      return `Goal is ${goal.status}; ${control} is unavailable`;
    },
    quit: onQuit,
    setNotice: setCommandNotice,
    updateExperience: setExperience,
  });

  useKeyboard((key) => {
    const control = runtimeControlAction({
      keyName: key.name,
      ctrl: key.ctrl,
      isRunning: snapshot.status !== 'idle' || Boolean(goal && ['pending', 'running'].includes(goal.status)),
      hasSurface: experience.surface.type !== 'composer'
        && experience.surface.type !== 'slash-suggestions',
      hasDraft: composerDraft.length > 0,
    });
    if (control === 'interrupt') {
      controller.cancel();
      if (goal && ['pending', 'running', 'paused'].includes(goal.status)) goalRunner.cancel(goal.goalId);
      setCommandNotice('Interrupt requested');
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
        setCommandNotice(`Next message: ${modelSelectionLabel(modelSelection, next)}`);
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
        setCommandNotice(`Local access: ${permissionPolicyLabels(normalized).label}`);
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
        const selected = resumeItems[resumeSurface.selectedIndex];
        if (!selected) {
          setCommandNotice('No session selected');
          return;
        }
        if (snapshot.status !== 'idle') {
          setCommandNotice('Cannot resume a session while a response is running');
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
          return;
        }
        if (conversation.modelSelection) {
          modelSelection.setSelection(conversation.modelSelection);
        }
        setExperience((current) => escapeFooter({
          ...current,
          mode: conversation.mode,
        }));
        setComposerDraft('');
        setCommandNotice(`Resumed: ${selected.title}`);
        queueMicrotask(() => composerRef.current?.focus());
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
    if (goal && !approval && snapshot.plan?.status !== 'awaiting_approval') {
      if (key.name === 'p' && goal.status === 'running') {
        goalRunner.pause(goal.goalId);
        return;
      }
      if (key.name === 'r' && goal.status === 'paused') {
        void goalRunner.resume(goal.goalId);
        return;
      }
      if (key.name === 'c' && ['pending', 'running', 'paused'].includes(goal.status)) {
        controller.cancel();
        goalRunner.cancel(goal.goalId);
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
    <box flexDirection="column" width="100%" height="100%" paddingLeft={layout.outerPadding} paddingRight={layout.outerPadding} gap={1} backgroundColor={COLOR.background}>
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
                editorRef={composerRef}
                status={composerStatus}
                statusLayout={composerStatusLayout}
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
          <ChatHistory snapshot={snapshot} />

      {snapshot.error ? <ErrorBanner message={snapshot.error} /> : null}

      {snapshot.plan?.status === 'awaiting_approval' ? (
        <box flexDirection="column" border borderColor={COLOR.user} padding={1} backgroundColor={COLOR.panel}>
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
                  backgroundColor={selected ? PICKER_CHROME.selectedBackground : PICKER_CHROME.idleBackground}
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

      {goal ? (
        <box flexDirection="column" border borderColor={COLOR.success} padding={1} backgroundColor={COLOR.panel}>
          <text fg={COLOR.success}><strong>Goal</strong> · {goal.title} · {goal.status}</text>
          <text fg={COLOR.muted}>source {goal.sourcePlanId} · {goal.tasks.filter((task) => task.status === 'completed').length}/{goal.tasks.length} tasks</text>
          {goal.tasks.map((task) => (
            <text
              key={task.taskId}
              fg={task.status === 'completed'
                ? COLOR.success
                : task.status === 'running'
                  ? COLOR.diffHunk
                  : task.status === 'failed' || task.status === 'blocked'
                    ? COLOR.danger
                    : COLOR.muted}
            >
              {task.status === 'completed' ? '✓' : task.status === 'running' ? '▶' : task.status === 'failed' || task.status === 'blocked' ? '!' : '○'} {task.title}
              {task.reason ? ` · ${task.reason}` : ''}
            </text>
          ))}
          <text fg={COLOR.muted}>[p] Pause · [r] Resume · [c] Cancel</text>
        </box>
      ) : null}

      {approval ? (() => {
        const details = approvalCardDetails(approval.prompt);
        return (
          <box flexDirection="column" border borderColor={COLOR.danger} paddingLeft={1} paddingRight={1} flexShrink={0} backgroundColor={COLOR.panel}>
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
                    backgroundColor={selected ? PICKER_CHROME.selectedBackground : PICKER_CHROME.idleBackground}
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
        <text fg={COLOR.accent}>{commandNotice}</text>
      ) : null}

      {permissionSurface ? (
        <box
          flexDirection="column"
          height={pickerLayout.modePanelRows}
          flexShrink={0}
          border
          borderColor={COLOR.accent}
          backgroundColor={COLOR.panel}
          paddingLeft={1}
          paddingRight={1}
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
                backgroundColor={selected ? PICKER_CHROME.selectedBackground : PICKER_CHROME.idleBackground}
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
        />
      ) : null}

      {modeSurface ? (
        <box
          flexDirection="column"
          height={pickerLayout.modePanelRows}
          flexShrink={0}
          border
          borderColor={COLOR.accent}
          backgroundColor={COLOR.panel}
          paddingLeft={1}
          paddingRight={1}
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
                backgroundColor={selected ? PICKER_CHROME.selectedBackground : PICKER_CHROME.idleBackground}
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
          border
          borderColor={COLOR.accent}
          backgroundColor={COLOR.panel}
          paddingLeft={1}
          paddingRight={1}
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

      {commandSurface ? (
        <box
          flexDirection="column"
          flexShrink={0}
          border
          borderColor={COLOR.accent}
          backgroundColor={COLOR.panel}
          paddingLeft={1}
          paddingRight={1}
          paddingTop={pickerLayout.verticalPadding}
          paddingBottom={pickerLayout.verticalPadding}
        >
          <text fg={COLOR.accent} wrapMode="none"><strong>Commands</strong></text>
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
                backgroundColor={selected ? PICKER_CHROME.selectedBackground : PICKER_CHROME.idleBackground}
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
          editorRef={composerRef}
          status={composerStatus}
          statusLayout={composerStatusLayout}
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
          onValueChange={(value) => {
            setComposerDraft(value);
            setExperience((current) => syncSlashSuggestions(current, value));
          }}
        />
      )}
        </>
      )}
    </box>
  );
}
