import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { TextareaRenderable } from '@opentui/core';
import { useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/react';
import type { RuntimeGoalSnapshot } from '@peer-agent/runtime-sdk';

import { B3Wordmark } from './b3-wordmark-view.tsx';
import {
  createChatController,
  type ChatController,
  type ChatMessage,
  type ChatModelPort,
  type ChatSnapshot,
} from './chat-controller.ts';
import {
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
import type { PendingApproval, TuiHost } from './tui-host.ts';
import {
  applyTuiCommand,
  createTuiExperienceState,
  escapeFooter,
  filterTuiCommands,
  openCommandPanel,
  shouldOpenCommandPanel,
  type TuiExperienceState,
} from './tui-experience.ts';
import { tuiModeOption } from './tui-mode.ts';

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
    <scrollbox flexGrow={1} stickyScroll stickyStart="bottom" paddingLeft={2} paddingRight={2}>
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

function Composer({ controller, snapshot, disabled, onCommand, editorRef }: {
  readonly controller: ChatController;
  readonly snapshot: ChatSnapshot;
  readonly disabled: boolean;
  readonly onCommand: () => void;
  readonly editorRef: RefObject<TextareaRenderable | null>;
}) {
  const editor = editorRef;

  const submit = () => {
    const value = editor.current?.plainText ?? '';
    if (!value.trim() || disabled || snapshot.status !== 'idle') return;
    if (value.trim() === '/') {
      editor.current?.clear();
      onCommand();
      return;
    }
    editor.current?.clear();
    void controller.send(value);
  };

  return (
    <box flexDirection="column" border borderColor={snapshot.status === 'idle' ? COLOR.border : COLOR.accent} height={5} paddingLeft={1} paddingRight={1} backgroundColor={COLOR.panel}>
      <textarea
        ref={editor}
        focused={!disabled}
        placeholder={disabled ? 'Resolve the request above…' : 'Ask anything…'}
        wrapMode="word"
        onKeyDown={(event) => {
          const value = editor.current?.plainText ?? '';
          if (!disabled && snapshot.status === 'idle' && shouldOpenCommandPanel(`${value}${event.sequence}`)) {
            event.preventDefault();
            event.stopPropagation();
            editor.current?.clear();
            onCommand();
          }
        }}
        onSubmit={submit}
      />
    </box>
  );
}

export function App({ host, model, modelLabel }: {
  readonly host: TuiHost;
  readonly model: ChatModelPort;
  readonly modelLabel: string;
}) {
  const renderer = useRenderer();
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
  const [experience, setExperience] = useState<TuiExperienceState>(() => createTuiExperienceState());
  const visibleTurn = snapshot.session?.activeTurn ?? snapshot.session?.lastTurn;
  const commandFooter = experience.footer.type === 'command' ? experience.footer : null;
  const commandItems = commandFooter ? filterTuiCommands(commandFooter.query) : [];
  const commandSelection = commandFooter?.selectedIndex ?? 0;
  const toolCount = (host.capabilitiesForMode?.(snapshot.mode) ?? host.capabilities).length;
  const composerMetadata = `${modelLabel}  ·  ${tuiModeOption(snapshot.mode).label.toLowerCase()}  ·  ${toolCount} tools`;
  const wordmarkVariant = terminal.width >= 76
    ? 'full'
    : terminal.width >= 42
      ? 'half'
      : 'narrow';
  const isWelcome = snapshot.messages.length === 0
    && !approval
    && snapshot.plan?.status !== 'awaiting_approval'
    && !goal
    && !snapshot.error
    && experience.footer.type === 'composer';

  useEffect(() => controller.subscribe(setSnapshot), [controller]);
  useEffect(() => goalRunner.subscribe(setGoal), [goalRunner]);
  useEffect(() => host.subscribeApproval((next) => {
    setApprovalSelection(0);
    setApproval(next);
  }), [host]);

  useKeyboard((key) => {
    if (
      experience.footer.type === 'composer'
      && !approval
      && snapshot.plan?.status !== 'awaiting_approval'
      && snapshot.status === 'idle'
      && shouldOpenCommandPanel(composerRef.current?.plainText ?? '', key.sequence)
    ) {
      key.preventDefault();
      key.stopPropagation();
      composerRef.current?.clear();
      setCommandNotice(null);
      setExperience((current) => openCommandPanel({ ...current, mode: snapshot.mode }));
      return;
    }
    if (experience.footer.type === 'command') {
      if (key.name === 'escape') {
        setExperience((current) => escapeFooter(current));
        return;
      }
      if (key.name === 'up' || key.name === 'down') {
        const direction = key.name === 'up' ? -1 : 1;
        setExperience((current) => current.footer.type === 'command'
          ? { ...current, footer: { ...current.footer, selectedIndex: Math.max(0, Math.min(commandItems.length - 1, current.footer.selectedIndex + direction)) } }
          : current);
        return;
      }
      if ((key.name === 'return' || key.name === 'enter') && commandItems.length > 0) {
        const command = commandItems[commandSelection] ?? commandItems[0];
        if (!command) return;
        const action = command.action;
        if (action.type === 'set-mode') {
          controller.setMode(action.mode);
          setCommandNotice(`Mode changed to ${action.mode}`);
        } else if (action.type === 'goal-control') {
          if (!goal) setCommandNotice('No active goal');
          else if (action.control === 'pause' && goal.status === 'running') {
            goalRunner.pause(goal.goalId);
            setCommandNotice('Goal paused');
          } else if (action.control === 'resume' && goal.status === 'paused') {
            void goalRunner.resume(goal.goalId);
            setCommandNotice('Goal resumed');
          } else if (action.control === 'cancel' && ['pending', 'running', 'paused'].includes(goal.status)) {
            controller.cancel();
            goalRunner.cancel(goal.goalId);
            setCommandNotice('Goal cancelled');
          } else setCommandNotice(`Goal is ${goal.status}`);
        } else if (action.type === 'show-help') {
          setCommandNotice('↵ send · shift+↵ newline · / commands · esc close · ctrl+c stop/quit');
        } else if (action.type === 'select-model') {
          setCommandNotice(`Using ${modelLabel}; model switching is configured in the desktop client`);
        } else if (action.type === 'new-session') {
          setCommandNotice('New session is unavailable while conversation persistence is being finalized');
        } else if (action.type === 'quit') {
          renderer.destroy();
          return;
        }
        setExperience((current) => applyTuiCommand(current, command));
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
      else renderer.destroy();
      return;
    }
    if (snapshot.status !== 'idle') return;
    if ((key.ctrl && key.name === 'p') || (key.ctrl && key.name === 'k')) {
      setExperience((current) => openCommandPanel({ ...current, mode: snapshot.mode }));
    }
  });

  return (
    <box flexDirection="column" width="100%" height="100%" paddingLeft={2} paddingRight={2} gap={1} backgroundColor={COLOR.background}>
      {isWelcome ? (
        <box flexGrow={1} flexDirection="column" justifyContent="center" alignItems="center" paddingLeft={2} paddingRight={2}>
          <box width="100%" flexDirection="column" alignItems="center" gap={2}>
            <box width="100%" alignItems="center" justifyContent="center">
              <B3Wordmark variant={wordmarkVariant} />
            </box>
            <box width="75%" maxWidth={88}>
              <Composer
                controller={controller}
                snapshot={snapshot}
                disabled={false}
                editorRef={composerRef}
                onCommand={() => {
                  setCommandNotice(null);
                  setExperience((current) => openCommandPanel({ ...current, mode: snapshot.mode }));
                }}
              />
            </box>
          </box>
        </box>
      ) : (
        <>
          {snapshot.messages.length > 0 ? (
            <box justifyContent="space-between">
              <text fg={COLOR.text}><strong>peer</strong></text>
              <text fg={COLOR.muted}>
                {snapshot.usage?.totalTokens === undefined ? composerMetadata : `${composerMetadata}  ·  ${snapshot.usage.totalTokens} tokens`}
              </text>
            </box>
          ) : null}

          {snapshot.session && visibleTurn ? (
            <text fg={COLOR.muted}>turn {visibleTurn.turnIndex} · {visibleTurn.status}</text>
          ) : null}

          <ChatHistory snapshot={snapshot} />

      {snapshot.error ? <text fg="#fca5a5">{snapshot.error}</text> : null}

      {snapshot.plan?.status === 'awaiting_approval' ? (
        <box flexDirection="column" border borderColor="#60a5fa" padding={1}>
          <text fg="#93c5fd"><strong>Plan approval</strong> · {snapshot.plan.plan.title}</text>
          <text fg="#e2e8f0">{snapshot.plan.plan.goal}</text>
          {snapshot.plan.plan.tasks.map((task, index) => (
            <text key={task.taskId} fg="#94a3b8">{index + 1}. {task.title}</text>
          ))}
          <box flexDirection="row" gap={2}>
            {PLAN_APPROVAL_OPTIONS.map((option, index) => (
              <text key={option.decision} fg={option.color}>
                {index === planSelection ? '▶ ' : '  '}
                [{option.shortcut}] {option.label}
              </text>
            ))}
          </box>
          <text fg="#64748b">←/→ or Tab select · Enter confirm · Esc Reject</text>
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
            {approval.prompt.capabilityId} · {approval.prompt.confirmation.kind}
          </text>
          <text fg="#94a3b8">{approval.prompt.reason}</text>
          <text fg="#94a3b8">
            scope {approval.sessionId ? `session ${approval.sessionId}` : 'this request only'}
          </text>
          <box flexDirection="row" gap={2}>
            {TUI_APPROVAL_OPTIONS.map((option, index) => (
              <text key={option.decision} fg={option.color}>
                {index === approvalSelection ? '▶ ' : '  '}
                [{option.shortcut}] {option.label}
              </text>
            ))}
          </box>
          <text fg="#64748b">←/→ or Tab select · Enter confirm · Esc deny</text>
        </box>
      ) : null}

      {commandNotice && experience.footer.type !== 'command' ? (
        <text fg={COLOR.accent}>{commandNotice}</text>
      ) : null}

      {experience.footer.type === 'command' ? (
        <box flexDirection="column" border borderColor={COLOR.accent} backgroundColor={COLOR.panel} padding={1}>
          <text fg={COLOR.accent}><strong>Commands</strong></text>
          {commandItems.map((command, index) => (
            <box key={command.id} justifyContent="space-between">
              <text fg={index === commandSelection ? COLOR.text : COLOR.muted}>
                {index === commandSelection ? '› ' : '  '}{command.label}
              </text>
              <text fg={COLOR.muted}>{command.description}</text>
            </box>
          ))}
          <text fg={COLOR.muted}>↑↓ select  ·  enter run  ·  esc close</text>
        </box>
      ) : (
        <Composer
          controller={controller}
          snapshot={snapshot}
          disabled={Boolean(approval) || snapshot.plan?.status === 'awaiting_approval'}
          editorRef={composerRef}
          onCommand={() => {
            setCommandNotice(null);
            setExperience((current) => openCommandPanel({ ...current, mode: snapshot.mode }));
          }}
        />
      )}
        </>
      )}
    </box>
  );
}
