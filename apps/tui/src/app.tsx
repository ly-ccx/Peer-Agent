import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { TextareaRenderable } from '@opentui/core';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import type { RuntimeGoalSnapshot } from '@peer-agent/runtime-sdk';
import type { RuntimeModelSelection, RuntimePermissionPolicy } from '@peer-agent/runtime-node';

import { B3Wordmark } from './b3-wordmark-view.tsx';
import { executeTuiCommand } from './command-execution.ts';
import {
  createTuiConversationPersistence,
  type TuiConversationSummary,
} from './conversation-persistence.ts';
import {
  ComposerStatusBar,
  type ComposerStatusLayout,
} from './composer-status-view.tsx';
import { createComposerStatus, type ComposerStatus } from './composer-status.ts';
import {
  createChatController,
  type ChatController,
  type ChatMessage,
  type ChatModelPort,
  type ChatSnapshot,
} from './chat-controller.ts';
import {
  approvalDecisionForKey,
  formatApprovalArguments,
  formatApprovalRisk,
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
  modelPickerItems,
  modelSelectionLabel,
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
import { runtimeControlAction, shouldHandleComposerSubmit } from './runtime-controls.ts';
import { responsiveLayout } from './responsive-layout.ts';
import {
  applyTuiCommand,
  createTuiExperienceState,
  escapeFooter,
  filterTuiCommands,
  openCommandPanel,
  slashCommandWindow,
  syncSlashSuggestions,
  type TuiCommand,
  type TuiExperienceState,
  updateCommandPanelQuery,
} from './tui-experience.ts';

const COLOR = {
  background: '#0a0a0a',
  panel: '#111111',
  border: '#2a2a2a',
  muted: '#737373',
  text: '#e5e5e5',
  accent: '#a3e635',
  user: '#7dd3fc',
  tool: '#facc15',
  danger: '#fb7185',
} as const;

function roleColor(role: ChatMessage['role']): string {
  if (role === 'user') return COLOR.user;
  if (role === 'tool') return COLOR.tool;
  return COLOR.text;
}

function ChatHistory({ snapshot }: { readonly snapshot: ChatSnapshot }) {
  if (snapshot.messages.length === 0) return null;

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
      {snapshot.messages.map((message) => (
        <box key={message.id} flexDirection="column" marginBottom={1}>
          <text fg={roleColor(message.role)}>
            <strong>{message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Peer' : 'Tool'}</strong>
            {message.pending ? '  thinking…' : ''}
          </text>
          <text fg={COLOR.text}>{message.content || ' '}</text>
        </box>
      ))}
    </scrollbox>
  );
}

function ErrorBanner({ message }: { readonly message: string }) {
  return (
    <box height={1} flexShrink={0} paddingLeft={2} paddingRight={2}>
      <text fg="#fca5a5" wrapMode="none">Error: {message}</text>
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
            backgroundColor={selected ? '#1c1c1c' : COLOR.panel}
          >
            <text fg={selected ? COLOR.accent : COLOR.text} wrapMode="none">
              {selected ? '› ' : '  '}/{command.id}
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

function ResumePickerMenu({ rows, selectedIndex }: {
  readonly rows: readonly TuiConversationSummary[];
  readonly selectedIndex: number;
}) {
  return (
    <box position="absolute" left={0} right={0} bottom={5} zIndex={100} flexDirection="column" border borderColor={COLOR.border} backgroundColor={COLOR.panel} paddingLeft={1} paddingRight={1}>
      <text fg={COLOR.accent} wrapMode="none"><strong>Resume session</strong></text>
      {rows.length === 0 ? <text fg={COLOR.muted}>No saved conversations to resume.</text> : rows.slice(0, 8).map((row, index) => (
        <text key={row.id} fg={index === selectedIndex ? COLOR.accent : COLOR.text} wrapMode="none">
          {index === selectedIndex ? '› ' : '  '}{row.title}  ({row.messageCount} messages)
        </text>
      ))}
      <text fg={COLOR.muted} wrapMode="none">↑↓ choose · enter resume · esc close</text>
    </box>
  );
}

interface ModelPickerRow {
  readonly key: string;
  readonly label: string;
  readonly current: boolean;
}

function ModelPickerMenu({ rows, selectedIndex, maxVisible, showHint }: {
  readonly rows: readonly ModelPickerRow[];
  readonly selectedIndex: number;
  readonly maxVisible: number;
  readonly showHint: boolean;
}) {
  const start = Math.max(0, Math.min(
    selectedIndex - Math.floor(maxVisible / 2),
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
      <text fg={COLOR.accent} wrapMode="none"><strong>Model &amp; reasoning</strong></text>
      {visibleRows.length === 0 ? (
        <text fg="#f59e0b" wrapMode="none">No configured model is available.</text>
      ) : visibleRows.map((row, offset) => {
        const selected = start + offset === selectedIndex;
        return (
          <text key={row.key} fg={selected ? COLOR.accent : COLOR.text} wrapMode="none">
            {selected ? '› ' : '  '}{row.label}{row.current ? '  current' : ''}
          </text>
        );
      })}
      {showHint ? <text fg={COLOR.muted} wrapMode="none">↑↓ choose · enter apply · esc close</text> : null}
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
    if (!trimmed || trimmed.startsWith('/') || disabled || snapshot.status !== 'idle') return;
    editor.current?.clear();
    void controller.send(value);
  };

  return (
    <box flexDirection="column" border borderColor={snapshot.status === 'idle' ? COLOR.border : COLOR.accent} height={5} paddingLeft={1} paddingRight={1} backgroundColor={COLOR.panel}>
      <textarea
        ref={editor}
        focused={focused && !disabled}
        placeholder={disabled ? 'Resolve the request above…' : 'Ask anything…'}
        wrapMode="word"
        onContentChange={() => onValueChange(editor.current?.plainText ?? '')}
        onKeyDown={(event) => {
          if ((event.name === 'return' || event.name === 'enter') && !shouldHandleComposerSubmit(event.eventType)) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
        onSubmit={submit}
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
  readonly modelPickerRows: readonly ModelPickerRow[];
  readonly modelPickerSelection: number;
  readonly modelPickerMaxVisible: number;
  readonly modelPickerShowHint: boolean;
}) {
  const menuReserve = slashOpen
    ? Math.min(slashMaxVisible, Math.max(1, slashItems.length)) + 2
    : modelPickerOpen
      ? Math.min(modelPickerMaxVisible, Math.max(1, modelPickerRows.length)) + 2
      : 0;

  return (
    <box flexDirection="column" flexShrink={0} width="100%" paddingTop={menuReserve}>
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
  const persistence = useMemo(() => createTuiConversationPersistence({
    workspacePath: process.cwd(),
    initialMode: controller.getSnapshot().mode,
    initialModel: modelSelection?.getSelection() ?? {
      providerId: 'unknown',
      modelId: modelLabel,
      reasoningEffort: 'default',
    },
  }), [controller, modelLabel, modelSelection]);
  const [permissionPolicy, setPermissionPolicy] = useState<RuntimePermissionPolicy>('ask');
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
  const permissionSurface = experience.surface.type === 'picker' && experience.surface.picker === 'permission'
    ? experience.surface
    : null;
  const modelItems = modelSelection ? modelPickerItems(modelSelection) : [];
  const modelPickerRows: readonly ModelPickerRow[] = modelItems.map((item) => ({
    key: `${item.providerId}:${item.modelId}:${item.reasoningEffort}`,
    label: modelSelection ? modelSelectionLabel(modelSelection, item) : item.modelId,
    current: selectedModel?.providerId === item.providerId
      && selectedModel.modelId === item.modelId
      && selectedModel.reasoningEffort === item.reasoningEffort,
  }));
  const commandSelection = commandSurface?.selectedIndex ?? 0;
  const slashSelection = slashSurface?.selectedIndex ?? 0;
  const modeSelection = modeSurface?.selectedIndex ?? 0;
  const modelPickerSelection = modelSurface?.selectedIndex ?? 0;
  const permissionSelection = permissionSurface?.selectedIndex ?? permissionPolicyIndex(permissionPolicy);
  const activeTurnMode = snapshot.activeTurnMode;
  const selectedModelLabel = selectedModel && modelSelection
    ? modelSelectionLabel(modelSelection, selectedModel)
    : modelLabel;
  const composerStatus = createComposerStatus({
    workspaceRoot: host.workspaceRoot,
    mode: snapshot.mode,
    permissionPolicy,
    modelLabel: selectedModelLabel,
    reasoningEffort: selectedModel?.reasoningEffort,
    usage: snapshot.usage,
  });
  const layout = responsiveLayout(terminal.width);
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
  const welcomeModelVisibleRows = Math.min(welcomeModelMaxVisible, Math.max(1, modelPickerRows.length));
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
        setExperience((current) => escapeFooter(current));
        queueMicrotask(() => composerRef.current?.focus());
        return;
      }
      if (modelItems.length === 0) return;
      if (key.name === 'up' || key.name === 'left') {
        setExperience((current) => ({
          ...current,
          surface: moveTuiSurfaceSelection(current.surface, -1, modelItems.length),
        }));
        return;
      }
      if (key.name === 'down' || key.name === 'right' || key.name === 'tab') {
        setExperience((current) => ({
          ...current,
          surface: moveTuiSurfaceSelection(current.surface, 1, modelItems.length),
        }));
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        const next = modelItems[modelPickerSelection % modelItems.length];
        if (!next || !modelSelection) return;
        modelSelection.setSelection(next);
        persistence.syncModel(next);
        setSelectedModel(next);
        setCommandNotice(`Next message: ${modelSelectionLabel(modelSelection, next)}`);
        setExperience((current) => escapeFooter(current));
        queueMicrotask(() => composerRef.current?.focus());
        return;
      }
    }

    if (resumeSurface) {
      if (key.name === 'escape') {
        setExperience((current) => escapeFooter(current));
        queueMicrotask(() => composerRef.current?.focus());
        return;
      }
      if (key.name === 'up') {
        setExperience((current) => ({ ...current, surface: moveTuiSurfaceSelection(current.surface, -1, resumeItems.length) }));
        return;
      }
      if (key.name === 'down' || key.name === 'tab') {
        setExperience((current) => ({ ...current, surface: moveTuiSurfaceSelection(current.surface, 1, resumeItems.length) }));
        return;
      }
      if ((key.name === 'return' || key.name === 'enter') && resumeItems.length > 0) {
        const item = resumeItems[resumeSurface.selectedIndex];
        const restored = item ? persistence.loadConversation(item.id) : null;
        if (!restored) {
          setCommandNotice('That saved session could not be restored');
        } else if (controller.restore(restored)) {
          persistence.resumeConversation(restored);
          if (restored.modelSelection && modelSelection) {
            modelSelection.setSelection(restored.modelSelection);
            setSelectedModel(restored.modelSelection);
          }
          setCommandNotice(`Resumed ${item?.title ?? 'saved session'}`);
        }
        setExperience((current) => escapeFooter(current));
        queueMicrotask(() => composerRef.current?.focus());
        return;
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
        setPermissionPolicy(nextPolicy);
        setCommandNotice(`Permissions for this session: ${permissionPolicyLabels(nextPolicy).label}`);
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
          {snapshot.messages.length > 0 ? (
            <text fg={COLOR.text}><strong>peer</strong></text>
          ) : null}

          {snapshot.session && visibleTurn ? (
            <text fg={COLOR.muted}>turn {visibleTurn.turnIndex} · {visibleTurn.status}</text>
          ) : null}

          <ChatHistory snapshot={snapshot} />

      {snapshot.error ? <ErrorBanner message={snapshot.error} /> : null}

      {snapshot.plan?.status === 'awaiting_approval' ? (
        <box flexDirection="column" border borderColor="#60a5fa" padding={1}>
          <text fg="#93c5fd"><strong>Plan approval</strong> · {snapshot.plan.plan.title}</text>
          <text fg="#e2e8f0">{snapshot.plan.plan.goal}</text>
          {snapshot.plan.plan.tasks.map((task, index) => (
            <text key={task.taskId} fg="#94a3b8">{index + 1}. {task.title}</text>
          ))}
          <box flexDirection={layout.stackActions ? 'column' : 'row'} gap={layout.stackActions ? 0 : 2}>
            {PLAN_APPROVAL_OPTIONS.map((option, index) => (
              <text key={option.decision} fg={option.color}>
                {index === planSelection ? '▶ ' : '  '}
                [{option.shortcut}] {option.label}
              </text>
            ))}
          </box>
          {layout.showHints ? <text fg="#64748b">←/→ or Tab select · Enter confirm · Esc Reject</text> : null}
        </box>
      ) : null}

      {goal ? (
        <box flexDirection="column" border borderColor="#22c55e" padding={1}>
          <text fg="#86efac"><strong>Goal</strong> · {goal.title} · {goal.status}</text>
          <text fg="#94a3b8">source {goal.sourcePlanId} · {goal.tasks.filter((task) => task.status === 'completed').length}/{goal.tasks.length} tasks</text>
          {goal.tasks.map((task) => (
            <text key={task.taskId} fg={task.status === 'completed' ? '#86efac' : task.status === 'running' ? '#67e8f9' : '#94a3b8'}>
              {task.status === 'completed' ? '✓' : task.status === 'running' ? '▶' : task.status === 'failed' || task.status === 'blocked' ? '!' : '○'} {task.title}
              {task.reason ? ` · ${task.reason}` : ''}
            </text>
          ))}
          <text fg="#64748b">[p] Pause · [r] Resume · [c] Cancel</text>
        </box>
      ) : null}

      {approval ? (
        <box flexDirection="column" border borderColor="#fb7185" padding={1}>
          <text fg="#fecdd3"><strong>Permission required</strong></text>
          <text fg="#fda4af">
            {approval.prompt.toolName} · {approval.prompt.capabilityId}
          </text>
          <text fg="#cbd5e1">args: {formatApprovalArguments(approval.prompt.args)}</text>
          <text fg="#94a3b8">reason: {approval.prompt.reason}</text>
          <text fg="#94a3b8">
            scope: {approval.prompt.workspacePath ?? host.workspaceRoot} · {approval.prompt.scope.kind}
          </text>
          <text fg="#fbbf24">risk: {formatApprovalRisk(approval.prompt.riskLevel)}</text>
          <box flexDirection={layout.stackActions ? 'column' : 'row'} gap={layout.stackActions ? 0 : 2}>
            {TUI_APPROVAL_OPTIONS.map((option, index) => (
              <text key={option.decision} fg={option.color}>
                {index === approvalSelection ? '▶ ' : '  '}
                [{option.shortcut}] {option.label}
              </text>
            ))}
          </box>
          {layout.showHints ? <text fg="#64748b">←/→ or Tab select · Enter confirm · Esc deny</text> : null}
        </box>
      ) : null}

      {commandNotice && !commandSurface ? (
        <text fg={COLOR.accent}>{commandNotice}</text>
      ) : null}

      {permissionSurface ? (
        <box flexDirection="column" border borderColor={COLOR.accent} backgroundColor={COLOR.panel} padding={1} gap={1}>
          <text fg={COLOR.text}><strong>Permissions for this session</strong></text>
          {TUI_PERMISSION_POLICIES.map((option, index) => (
            <box key={option.policy} flexDirection="column">
              <text fg={index === permissionSelection ? COLOR.accent : COLOR.text}>
                {index === permissionSelection ? '●' : ' '} {option.shortcut}. {option.label}
                {option.policy === permissionPolicy ? '  current' : ''}
              </text>
              {layout.showDescriptions ? <text fg={COLOR.muted}>   {option.description}</text> : null}
            </box>
          ))}
          <text fg={COLOR.muted}>Runtime deny rules and irreversible-action gates always win.</text>
          {layout.showHints ? <text fg={COLOR.muted}>↑↓ select  ·  1–3 choose  ·  enter apply  ·  esc close</text> : null}
        </box>
      ) : null}

      {resumeSurface ? (
        <ResumePickerMenu rows={resumeItems} selectedIndex={resumeSurface.selectedIndex} />
      ) : null}

      {modeSurface ? (
        <box flexDirection="column" border borderColor={COLOR.accent} backgroundColor={COLOR.panel} padding={1}>
          <text fg={COLOR.accent}><strong>Mode</strong></text>
          {activeTurnMode && activeTurnMode !== snapshot.mode ? (
            <text fg={COLOR.muted}>
              Current turn: {tuiModeOption(activeTurnMode).label} · Next message: {tuiModeOption(snapshot.mode).label}
            </text>
          ) : (
            <text fg={COLOR.muted}>Choose how the next message should run</text>
          )}
          {TUI_MODES.map((option, index) => (
            <box key={option.mode} flexDirection="column">
              <text fg={index === modeSelection ? COLOR.text : COLOR.muted}>
                {index === modeSelection ? '› ' : '  '}[{option.shortcut}] {option.label}{snapshot.mode === option.mode ? '  current' : ''}
              </text>
              {layout.showDescriptions ? <text fg={COLOR.muted}>    {option.description}</text> : null}
            </box>
          ))}
          {layout.showHints ? <text fg={COLOR.muted}>↑↓ select · 1–3 direct · enter confirm · esc close</text> : null}
        </box>
      ) : null}

      {commandSurface ? (
        <box flexDirection="column" border borderColor={COLOR.accent} backgroundColor={COLOR.panel} padding={1}>
          <text fg={COLOR.accent}><strong>Commands</strong></text>
          <text fg={COLOR.muted}>{commandSurface.query ? `Search: ${commandSurface.query}` : 'Type to search commands'}</text>
          {commandItems.map((command, index) => (
            <box key={command.id} justifyContent="space-between">
              <text fg={index === commandSelection ? COLOR.text : COLOR.muted}>
                {index === commandSelection ? '› ' : '  '}{command.label}
              </text>
              {layout.showDescriptions ? <text fg={COLOR.muted}>{command.description}</text> : null}
            </box>
          ))}
          {layout.showHints ? <text fg={COLOR.muted}>↑↓ select  ·  enter run  ·  esc close</text> : null}
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
