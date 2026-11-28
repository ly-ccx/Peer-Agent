import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createElement } from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import * as react from 'react';
import ts from 'typescript';
import { createI18n } from '@peer-agent/i18n';
import { canCancelTask, indexBotWork, replyTaskReferences, replyWork, workProgress } from './state/botWorkState.ts';
import { recencyBucketOf, sidebarActiveSessionsOf, summarizeActiveSessions } from './state/botNavigationState.ts';
import type { BotListItem, BotProfile } from '@peer-agent/protocol';
import { normalizeBotMessage } from './state/botConversationState.ts';
import { readDrawerSession } from './state/drawerState.ts';
import * as status from './state/workerStatus.ts';
import * as drawerState from './state/drawerState.ts';
import * as workPanelState from './state/botWorkPanelState.ts';
import * as agentActivityState from './state/agentActivityState.ts';
import { mergeTaskDetail } from './state/taskDetailState.ts';
import { taskExecutionTitle } from './state/taskExecutionDuration.ts';
import { verdictStrip } from './task-workspace/verdictStrip.ts';
import * as protocol from '@peer-agent/protocol';
import type { ExecutorIcon as Executor } from './ExecutorIcon';
import type { ReplyTaskReferences as InlineFeed } from './conversation/ReplyTaskReferences';
import type { BotSidebarTasks as SidebarTree } from './BotSidebarTasks';
import type { BotWorkSessionRow as WorkPanelRow } from './conversation/BotWorkSessionRow';
import type { AgentActivityRow as ActivityRow } from './conversation/AgentActivityRow';

function loadComponent<T>(file: string, imports: Record<string, unknown> = {}): T {
  const exports = {};
  const compiled = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  runInNewContext(compiled, {
    exports,
    require(id: string) {
      if (id === 'react/jsx-runtime') return jsxRuntime;
      if (id === 'react') return react;
      assert.ok(Object.hasOwn(imports, id), `Unexpected import ${id} in ${file}`);
      return imports[id];
    },
  });
  return exports as T;
}

const executors = loadComponent<typeof import('./ExecutorIcon')>('./ExecutorIcon.tsx');
const ExecutorIcon: typeof Executor = executors.ExecutorIcon;
const icons = {
  PeerIcon: ({ name, className }: { name: string; className?: string }) => createElement('svg', { 'data-icon': name, className }),
};
const { BotSidebarTasks } = loadComponent<{ BotSidebarTasks: typeof SidebarTree }>('./BotSidebarTasks.tsx', {
  './ExecutorIcon': executors,
  './state/workerStatus': status,
  './TaskExecutionDuration': { TaskExecutionDuration: () => null },
});
const { ReplyTaskReferences } = loadComponent<{ ReplyTaskReferences: typeof InlineFeed }>('./conversation/ReplyTaskReferences.tsx', {
  '../../ui/icons': { PeerIcon: () => null },
  '../ExecutorIcon': executors,
  '../state/botWorkState': { replyTaskReferences },
  '../state/workerStatus': status,
});
const { DelegatedWork } = loadComponent<typeof import('./conversation/DelegatedWork')>('./conversation/DelegatedWork.tsx', {
  '../../app/components/MotionDetails': { MotionDetails: 'details' },
  '../../ui/icons': icons,
  '../state/botWorkState': { workProgress },
  '../state/drawerState': drawerState,
  '../state/TaskCancellation': {
    TaskCancelButton: ({ task }: { task: { status: string | null; cancelable?: boolean } }) =>
      canCancelTask(task.status, task.cancelable) ? createElement('button', { 'data-cancel-task': true }) : null,
  },
  '../styles/bot-reply-context.css': {},
});
const { BotWorkSessionRow } = loadComponent<{ BotWorkSessionRow: typeof WorkPanelRow }>('./conversation/BotWorkSessionRow.tsx', {
  '@peer-agent/protocol': protocol,
  '../../ui/icons': icons,
  '../ExecutorIcon': executors,
  '../state/drawerState': drawerState,
  '../state/botWorkPanelState': workPanelState,
});
const { ComposerTouchBar } = loadComponent<typeof import('./conversation/ComposerTouchBar')>('./conversation/ComposerTouchBar.tsx', {
  '../../ui/icons': icons,
  '../ExecutorIcon': executors,
  '../state/drawerState': drawerState,
  '../state/botWorkState': { canCancelTask },
  '../state/botNavigationState': { summarizeActiveSessions },
});
const { TouchBarTray } = loadComponent<typeof import('./conversation/TouchBarTray')>('./conversation/TouchBarTray.tsx', {
  '../../clientApi': { clientApi: {} },
  '../ExecutorIcon': executors,
  '../../ui/icons': icons,
  '../../app/hooks/useInteractionLayer': { useInteractionLayer() {} },
  '../state/drawerState': drawerState,
  '../state/botNavigationState': { recencyBucketOf },
  '../state/workerStatus': status,
});
const workingPlanStrip = loadComponent<typeof import('./task-workspace/TaskWorkingPlanStrip')>('./task-workspace/TaskWorkingPlanStrip.tsx', {
  '../../ui/icons': icons,
  '../styles/task-working-plan-strip.css': {},
});
const { TaskWorkspaceView } = loadComponent<typeof import('./task-workspace/TaskWorkspaceView')>('./task-workspace/TaskWorkspaceView.tsx', {
  '@peer-agent/protocol': protocol,
  '../../clientApi': { clientApi: {} },
  '../../ui/icons': icons,
  '../../app/hooks/useCompositionGuard': { useCompositionGuard: () => ({}) },
  '../BotAccessControl': { BotAccessControl: () => null },
  '../state/drawerState': drawerState,
  '../state/taskDetailState': { mergeTaskDetail },
  '../TaskExecutionDuration': { TaskExecutionDuration: () => null },
  '../state/taskExecutionDuration': { taskExecutionTitle },
  '../state/useTaskReport': { useTaskReport: () => ({ detail: null }) },
  '../state/TaskCancellation': { useTaskCancellation: () => ({ states: {}, cancel() {} }) },
  '../state/taskCancellationFocus': {},
  '../conversation/ComposerTouchBar': { ComposerTouchBar },
  '../drawer/ConversationScene': { ConversationSceneDrawer: () => null },
  './TaskEvidenceInspector': { TaskEvidenceInspector: () => null },
  './TaskWorkingPlanStrip': workingPlanStrip,
  './verdictStrip': { verdictStrip },
  '../styles/bot-task-workspace.css': {},
  '../styles/bot-touchbar.css': {},
});
const { AgentActivityRow } = loadComponent<{ AgentActivityRow: typeof ActivityRow }>('./conversation/AgentActivityRow.tsx', {
  '../../ui/icons': { PeerIcon: () => null },
  '../ExecutorIcon': executors,
  '../state/agentActivityState': agentActivityState,
  '../state/drawerState': drawerState,
});
const i18n = createI18n('zh-CN');

test('Peer executor defaults to 14px, uses unique transparent eye masks and can expose a label', () => {
  const markup = renderToStaticMarkup(createElement(react.Fragment, null,
    createElement(ExecutorIcon), createElement(ExecutorIcon, { title: executors.executorDisplayName('peer', true) })));
  const ids = [...markup.matchAll(/<mask id="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, 2);
  assert.equal(new Set(ids).size, 2);
  for (const id of ids) assert.ok(markup.includes(`fill="currentColor" mask="url(#${id})"`));
  assert.match(markup, /width="14" height="14"/);
  assert.match(markup, /aria-hidden="true"/);
  assert.match(markup, /aria-label="Peer 小猫 CLI"/);
  assert.equal(executors.executorDisplayName('opencode', false), 'OpenCode');
  assert.doesNotMatch(renderToStaticMarkup(createElement(ExecutorIcon, { kind: 'opencode', flowing: true })),
    /<mask|<linearGradient|motion-iridescent-flow/);
});

test('sidebar uses the cat as the only leading icon and confines flow to active worker states', () => {
  const cases = [
    { status: 'running', tone: 'active', label: '执行中' },
    { status: 'starting', tone: 'active', label: '执行中' },
    { status: 'verifying', tone: 'active', label: '核验中' },
    { status: 'waiting_user', tone: 'warn', label: '待你确认' },
    { status: 'needs_user', tone: 'warn', label: '待你确认' },
    { status: 'result_ready', owner: 'user', reason: 'awaiting_human_gate', tone: 'warn', label: '待你确认' },
    { status: 'failed', tone: 'danger', label: '执行失败' },
    { status: 'result_ready', owner: 'bot', reason: 'verification_failed', tone: 'danger', label: '核验未通过' },
    { status: 'result_ready', owner: 'bot', reason: 'awaiting_acceptance_technical', tone: 'waiting', label: '等待主 Bot 汇报结果' },
    { status: 'queued', tone: 'queued' },
    { status: 'paused', tone: 'muted' },
    { status: 'accepted', tone: 'good', label: '已完成' },
    { status: 'cancelled', tone: 'muted', label: '已停止' },
  ] as const;
  const tasks = cases.map((item, index) => ({
    sessionId: String(index), title: `任务 ${index}`, status: item.status, updatedAt: '',
    followUp: 'owner' in item ? { owner: item.owner, reason: item.reason, inCurrentList: true } : undefined,
  }));
  const markup = renderToStaticMarkup(createElement(BotSidebarTasks, {
    workspaceId: 'ws', botName: 'Bot', tasks, total: tasks.length, activeSessionId: null,
    i18n, expandedMore: true, onOpenTask() {}, onToggleMore() {},
  }));
  assert.doesNotMatch(markup, /bot-sidebar-task-state|motion-spin/);

  const rows = [...markup.matchAll(/<button\b[^>]*data-session-id[^>]*>.*?<\/button>/g)].map(match => match[0]);
  assert.equal(rows.length, cases.length);
  const definitionIds = new Set<string>();
  for (const [index, item] of cases.entries()) {
    const row = rows[index]!;
    assert.ok(row.includes(`data-task-tone="${item.tone}"`));
    if ('label' in item) {
      assert.ok(row.includes(`title="任务 ${index} · ${item.label}"`));
      assert.ok(row.includes(`aria-label="任务 ${index} · ${item.label} · Peer 小猫 CLI"`));
    }
    assert.match(row, /"><svg[^>]*data-executor-kind="peer"[^>]*>.*<\/svg><span class="bot-sidebar-task-title">/);
    assert.equal((row.match(/<svg\b/g) ?? []).length, 1);

    const mask = row.match(/<mask id="([^"]+)"/)?.[1];
    assert.ok(mask);
    assert.equal(definitionIds.has(mask), false);
    definitionIds.add(mask);
    assert.ok(row.includes(`mask="url(#${mask})"`));
    if (item.tone === 'active') {
      const gradient = row.match(/<linearGradient id="([^"]+)"/)?.[1];
      assert.ok(gradient);
      assert.equal(definitionIds.has(gradient), false);
      definitionIds.add(gradient);
      assert.match(row, /class="motion-iridescent-flow"/);
      assert.ok(row.includes(`fill="url(#${gradient}) currentColor"`));
    } else {
      assert.doesNotMatch(row, /<linearGradient|motion-iridescent-flow/);
      assert.ok(row.includes('fill="currentColor"'));
    }
  }
});

test('sidebar presents four current host tasks plus overflow and retains the selected identity', () => {
  const live = Array.from({ length: 7 }, (_, index) => readDrawerSession({
    sessionId: `task-${index}`,
    status: index === 1 ? 'result_ready' : 'queued',
    title: `任务 ${index}`,
    followUp: index === 1
      ? { owner: 'bot', inCurrentList: true, reason: 'verification_failed' }
      : index === 5 ? { owner: 'none', inCurrentList: false, reason: 'settled' }
        : index === 6 ? { owner: 'none', inCurrentList: false, reason: 'obligation_indexed' }
          : { owner: 'bot', inCurrentList: true, reason: 'live_execution' },
  })!);
  const projection = sidebarActiveSessionsOf({} as BotListItem, live);
  const props = {
    workspaceId: 'ws', botName: 'Bot', tasks: projection.items, total: projection.total, activeSessionId: 'task-1',
    i18n, expandedMore: false, onOpenTask() {}, onToggleMore() {},
  };
  const collapsed = renderToStaticMarkup(createElement(BotSidebarTasks, props));
  assert.equal((collapsed.match(/data-session-id=/g) ?? []).length, 4);
  assert.match(collapsed, /data-session-id="task-1" data-task-tone="danger".*aria-current="page"/);
  assert.match(collapsed, /再显示 1 个任务/);
  const expanded = renderToStaticMarkup(createElement(BotSidebarTasks, { ...props, expandedMore: true }));
  assert.equal((expanded.match(/data-session-id=/g) ?? []).length, 5);
  assert.match(expanded, /收起部分任务/);
  assert.doesNotMatch(expanded, /data-session-id="task-[56]"|bot-sidebar-task-tag/);
});

test('inline workers prefer live status, keep the recorded fallback and retain unavailable references', () => {
  const live = readDrawerSession({ sessionId: 'review', status: 'result_ready', title: '复核变更',
    followUp: { owner: 'bot', inCurrentList: true, reason: 'verification_failed' } })!;
  const messages = [
    { id: 'reply', kind: 'agent_reply', role: 'assistant', sources: ['review', 'finished'], meta: { sessionStates: [
      { sessionId: 'review', status: 'running' }, { sessionId: 'finished', status: 'accepted' },
    ] } },
    { id: 'legacy-reply', kind: 'agent_reply', role: 'assistant', sources: ['legacy'] },
  ].map(message => {
    const parsed = normalizeBotMessage(message);
    assert.ok(parsed);
    return parsed;
  });
  const rows = replyTaskReferences(messages, indexBotWork([live], true));
  const markup = renderToStaticMarkup(createElement(ReplyTaskReferences, { rows, i18n, onOpen() {} }));
  assert.match(markup, /data-session-id="review" data-tone="danger" title="复核变更 · 核验未通过"/);
  assert.match(markup, /data-session-id="finished" data-tone="good" title="[^"]*已完成"/);
  assert.match(markup, /data-session-id="legacy" data-tone="muted"/);
  assert.equal((markup.match(/data-executor-kind="peer"/g) ?? []).length, 3);
  assert.equal((markup.match(/class="bot-inline-worker-dot"/g) ?? []).length, 2);

  // Explicit live rows (e.g. while awaiting worker execution) render active dot & live status.
  const activeTask = readDrawerSession({
    sessionId: 'live-research',
    status: 'running',
    title: '调研主流 Agent 的 ACP 支持',
    followUp: { owner: 'bot', inCurrentList: true, reason: 'live_execution' },
  })!;
  const liveMarkup = renderToStaticMarkup(createElement(ReplyTaskReferences, {
    rows: [{ id: 'live-research', session: activeTask, status: 'running' }],
    i18n,
    onOpen() {},
  }));
  assert.match(liveMarkup, /data-session-id="live-research" data-tone="active" title="调研主流 Agent 的 ACP 支持 · 执行中"/);
  assert.match(liveMarkup, /class="bot-inline-worker-dot"/);
});

test('delegated work keeps the task title when live facts are unavailable', () => {
  const session = readDrawerSession({ sessionId: 'review', title: '复核变更', status: 'verifying',
    verificationActive: true, cancelable: true })!;
  const reply = { sources: [session.sessionId], marks: [], meta: {}, replyTo: [] };
  const render = (available: boolean) => renderToStaticMarkup(createElement(DelegatedWork, {
    rows: replyWork(reply, indexBotWork([session], available)), botName: 'Peer', i18n, onOpen() {},
  }));
  const current = render(true);
  assert.match(current, /data-status="verifying"/);
  assert.match(current, /class="bot-work-status is-running">正在核对结果</);
  assert.match(current, /data-cancel-task/);

  const unavailable = render(false);
  assert.match(unavailable, /data-status="unavailable"/);
  assert.match(unavailable, /class="bot-work-title">复核变更</);
  assert.match(unavailable, /class="bot-work-status">状态暂不可用</);
  assert.doesNotMatch(unavailable, /is-running|正在核对结果|data-cancel-task/);
});

test('work panel rows and agent activity rows unify on Peer ExecutorIcon matching sidebar tasks', () => {
  const taskSession = readDrawerSession({
    sessionId: 'acp-research',
    status: 'running',
    title: '调研主流 Agent 的 ACP 支持',
    followUp: { owner: 'bot', inCurrentList: true, reason: 'live_execution' },
  })!;
  const taskMarkup = renderToStaticMarkup(createElement(BotWorkSessionRow, {
    session: taskSession,
    lane: 'doing',
    variant: 'task',
    i18n,
    onOpen() {},
  }));
  assert.match(taskMarkup, /bot-work-panel-agent-icon.*data-executor-kind="peer"/);
  assert.match(taskMarkup, /width="16" height="16"/);

  const subagentMarkup = renderToStaticMarkup(createElement(BotWorkSessionRow, {
    session: taskSession,
    lane: 'doing',
    variant: 'agent',
    i18n,
    onOpen() {},
  }));
  assert.match(subagentMarkup, /bot-work-panel-agent-icon.*data-executor-kind="peer"/);
  assert.match(subagentMarkup, /width="14" height="14"/);

  const activityMarkup = renderToStaticMarkup(createElement(AgentActivityRow, {
    messageId: 'm-1',
    activity: { eventId: 'ev-1', sessionId: 'acp-research', name: '调研主流 Agent 的 ACP 支持', state: 'started' },
    workIndex: indexBotWork([taskSession], true),
    i18n,
    onOpen() {},
  }));
  assert.match(activityMarkup, /bot-agent-marker[^>]*data-agent-icon="[^"]+".*data-executor-kind="peer"/);
});

test('task workspace header and Touch Bar animate only real execution or verification and use the matching action', () => {
  const followUp = { owner: 'bot', inCurrentList: true, reason: 'awaiting_acceptance_technical' };
  const renderWorkspace = (facts: Record<string, unknown>, locale: 'zh-CN' | 'en-US' = 'zh-CN') => {
    const liveSession = readDrawerSession({ sessionId: 'task', title: 'Prepare report', cancelable: true, ...facts })!;
    const i18n = createI18n(locale);
    return renderToStaticMarkup(createElement(TaskWorkspaceView, {
      workspaceId: 'ws', workspacePath: '/fixture', profile: { displayName: 'Peer' } as BotProfile,
      sessionId: liveSession.sessionId, liveSession, sessionsAvailable: true, context: null, inspectorOpen: false,
      inspectorTriggerRef: { current: null }, i18n, isZh: locale === 'zh-CN', onToggleInspector() {}, onCloseInspector() {},
      onBackToBot() {}, onTaskConversation() {}, onOpenTask() {}, onCiteToBot() {}, async onRefreshSessions() {},
    }));
  };
  const workingPlan = {
    epoch: 0, revision: 1, updatedAt: '2026-11-27T00:00:00Z',
    total: 1, completed: 1, blocked: 0, steps: [{ title: 'Prepare report', status: 'completed' }],
  };
  const awaiting = renderWorkspace({ status: 'result_ready', verificationActive: false, followUp, workingPlan });
  assert.match(awaiting, /aria-label="工作计划"/);
  assert.match(awaiting, /bot-task-status-pill[^>]*><svg data-icon="circle"><\/svg><span>等待主 Bot 汇报结果<\/span>/);
  assert.match(awaiting, /bot-tb-status-text">等待主 Bot 汇报结果/);
  assert.match(awaiting, /title="撤回任务" aria-label="撤回任务"><svg data-icon="close"><\/svg><span>撤回<\/span>/);
  assert.doesNotMatch(awaiting, /motion-spin|>停止</);
  assert.doesNotMatch(renderWorkspace({ status: 'result_ready', cancelable: false, followUp }), /撤回任务/);

  const awaitingEnglish = renderWorkspace({ status: 'result_ready', followUp }, 'en-US');
  assert.match(awaitingEnglish, /Waiting for main bot report/);
  assert.match(awaitingEnglish, /title="Withdraw task" aria-label="Withdraw task"/);

  const verifying = renderWorkspace({ status: 'verifying', conversationId: 'live-verifier', verificationActive: true, followUp, workingPlan });
  assert.match(verifying, /aria-label="工作计划"/);
  assert.equal((verifying.match(/data-icon="loader" class="motion-spin"/g) ?? []).length, 2);
  assert.match(verifying, /bot-task-status-pill[^>]*>.*<span>正在核对结果<\/span>/);
  assert.match(verifying, /bot-tb-status-text">正在核对结果/);
  assert.match(verifying, /data-icon="stop"><\/svg><span>停止<\/span>/);
  assert.doesNotMatch(verifying, /撤回任务/);

  const failed = renderWorkspace({ status: 'result_ready', followUp: { ...followUp, reason: 'verification_failed' } });
  assert.match(failed, /data-tone="danger"><svg data-icon="warning"><\/svg><span>核验未通过/);
  assert.match(failed, /重新核验/);
  assert.doesNotMatch(failed, /motion-spin|待汇报/);
});

test('the work panel, sidebar and Touch Bar tray distinguish an awaiting report from a live verifier', () => {
  const followUp = { owner: 'bot', inCurrentList: true, reason: 'awaiting_acceptance_technical' };
  const awaiting = readDrawerSession({
    sessionId: 'awaiting', status: 'result_ready', statusLabel: '结果待确认', report: { summary: '已生成结果' },
    verificationActive: false, followUp,
  })!;
  const verifying = readDrawerSession({ sessionId: 'verifying', status: 'verifying', verificationActive: true,
    verificationProgress: { continuationId: 'verify', startedAt: '2026-11-26T01:00:00Z', lastProgressAt: '2026-11-26T01:01:00Z',
      observationCount: 3, phase: 'tools' }, followUp })!;
  const row = (session: drawerState.DrawerSession) => renderToStaticMarkup(createElement(BotWorkSessionRow, {
    session, lane: session.status === 'result_ready' ? 'delivered' : 'doing', variant: 'task', i18n, onOpen() {},
  }));
  assert.match(row(awaiting), /data-icon="circle"><\/svg>等待主 Bot 汇报结果/);
  assert.match(row(awaiting), /已生成结果/);
  assert.doesNotMatch(row(awaiting), /motion-spin|正在核对结果/);
  assert.match(row(verifying), /data-icon="loader" class="motion-spin"><\/svg>正在核对结果/);
  assert.match(row(verifying), /已检查 3 项事实/);

  const projection = sidebarActiveSessionsOf({} as BotListItem, [awaiting, verifying]);
  const markup = renderToStaticMarkup(createElement(BotSidebarTasks, {
    workspaceId: 'ws', botName: 'Peer', tasks: projection.items, total: projection.total, activeSessionId: null,
    expandedMore: false, i18n, onOpenTask() {}, onToggleMore() {},
  }));
  const awaitingRow = markup.match(/<button[^>]*data-session-id="awaiting".*?<\/button>/)?.[0] ?? '';
  assert.match(awaitingRow, /data-task-tone="waiting" title="[^"]*等待主 Bot 汇报结果"/);
  assert.doesNotMatch(awaitingRow, /motion-iridescent-flow/);
  assert.match(markup, /data-session-id="verifying" data-task-tone="active" title="[^"]*核验中"[^>]*><svg.*?class="motion-iridescent-flow"/);

  const tray = renderToStaticMarkup(createElement(TouchBarTray, {
    mode: 'active', workspaceId: 'ws', botName: 'Peer', activeTasks: projection.items, historyTotalHint: 0,
    i18n, triggerRef: { current: null }, onClose() {}, onOpenTask() {}, onCiteTask() {},
  }));
  assert.match(tray, /bot-tray-row-sub">等待主 Bot 汇报结果</);
  assert.match(tray, /bot-tray-row-sub">核验中</);
  assert.doesNotMatch(tray, /结果待确认/);
  assert.equal((tray.match(/class="motion-iridescent-flow"/g) ?? []).length, 1);
});

test('withdrawal uses the shared confirmation before invoking cancel and leaves live stop immediate', async () => {
  const rpcCalls: unknown[] = [];
  const prompts: { title: string; message: string; confirmText: string; cancelText: string }[] = [];
  let resolveConfirm: (answer: boolean) => void = () => assert.fail('no confirmation is open');
  let rpcOk = true;
  let refreshes = 0;
  const cancellation = loadComponent<typeof import('./state/TaskCancellation')>('./state/TaskCancellation.tsx', {
    '../../clientApi': { clientApi: { async projectAgentCancelSession(input: object) {
      rpcCalls.push({ ...input });
      return { ok: rpcOk };
    } } },
    '../../app/components/ConfirmProvider': { useConfirm: () => (options: (typeof prompts)[number]) => {
      prompts.push(options);
      return new Promise<boolean>(resolve => { resolveConfirm = resolve; });
    } },
    '../../ui/icons': icons,
    './botWorkState': { canCancelTask },
    './drawerState': drawerState,
    './taskCancellationFocus': {},
    '../styles/bot-task-cancel.css': {},
  });
  const task = readDrawerSession({ sessionId: 'report', title: '检查变更', status: 'result_ready', cancelable: true,
    followUp: { owner: 'bot', inCurrentList: true, reason: 'awaiting_acceptance_technical' } })!;
  let cancel: NonNullable<ReturnType<typeof cancellation.useTaskCancellation>>['cancel'] | undefined;
  function Capture() {
    cancel = cancellation.useTaskCancellation()?.cancel;
    return createElement(cancellation.TaskCancelButton, { task, i18n });
  }
  const markup = renderToStaticMarkup(createElement(cancellation.TaskCancellationProvider, {
    workspaceId: 'ws', async onRefresh() { refreshes++; }, children: createElement(Capture),
  }));
  assert.match(markup, /title="撤回任务" aria-label="撤回任务 检查变更"[^>]*><svg data-icon="close"><\/svg>撤回/);
  assert.ok(cancel);
  const decline = cancel(task, i18n);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0]?.title, '撤回任务');
  assert.equal(prompts[0]?.confirmText, '撤回');
  assert.equal(prompts[0]?.cancelText, '保留任务');
  assert.match(prompts[0]!.message, /检查变更.*移出当前列表.*已生成的正文与证据会保留/);
  assert.equal(await cancel(task, i18n), false, 'a second click cannot replace the open confirmation');
  assert.deepEqual(rpcCalls, []);
  resolveConfirm(false);
  assert.equal(await decline, false);
  assert.deepEqual(rpcCalls, []);

  const accept = cancel(task, i18n);
  resolveConfirm(true);
  assert.equal(await accept, true);
  assert.deepEqual(rpcCalls, [{ workspaceId: 'ws', sessionId: 'report', reason: 'user_cancelled' }]);
  assert.equal(refreshes, 1);
  assert.equal(await cancel({ ...task, cancelable: false }, i18n), false);
  assert.equal(prompts.length, 2);

  rpcOk = false;
  assert.equal(await cancel({ ...task, sessionId: 'check', status: 'verifying', verificationActive: true }, i18n), false);
  assert.deepEqual(rpcCalls[1], { workspaceId: 'ws', sessionId: 'check', reason: 'user_cancelled' });
  assert.equal(prompts.length, 2);
  assert.equal(refreshes, 2);
});
