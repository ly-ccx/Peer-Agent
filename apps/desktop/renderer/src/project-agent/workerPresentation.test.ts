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
import { indexBotWork, replyTaskReferences } from './state/botWorkState.ts';
import { sidebarActiveSessionsOf } from './state/botNavigationState.ts';
import type { BotListItem } from '@peer-agent/protocol';
import { normalizeBotMessage } from './state/botConversationState.ts';
import { readDrawerSession } from './state/drawerState.ts';
import * as status from './state/workerStatus.ts';
import * as drawerState from './state/drawerState.ts';
import * as workPanelState from './state/botWorkPanelState.ts';
import * as agentActivityState from './state/agentActivityState.ts';
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
const { BotSidebarTasks } = loadComponent<{ BotSidebarTasks: typeof SidebarTree }>('./BotSidebarTasks.tsx', {
  './ExecutorIcon': executors,
  './state/workerStatus': status,
});
const { ReplyTaskReferences } = loadComponent<{ ReplyTaskReferences: typeof InlineFeed }>('./conversation/ReplyTaskReferences.tsx', {
  '../../ui/icons': { PeerIcon: () => null },
  '../ExecutorIcon': executors,
  '../state/botWorkState': { replyTaskReferences },
  '../state/workerStatus': status,
});
const { BotWorkSessionRow } = loadComponent<{ BotWorkSessionRow: typeof WorkPanelRow }>('./conversation/BotWorkSessionRow.tsx', {
  '@peer-agent/protocol': protocol,
  '../../ui/icons': { PeerIcon: () => null },
  '../ExecutorIcon': executors,
  '../state/drawerState': drawerState,
  '../state/botWorkPanelState': workPanelState,
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
  assert.doesNotMatch(renderToStaticMarkup(createElement(ExecutorIcon, {kind: 'opencode'})), /<mask/);
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
  const markup = renderToStaticMarkup(createElement(ReplyTaskReferences, { messages, i18n,
    workIndex: indexBotWork([live], true), onOpen() {} }));
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
    messages: [],
    rows: [{ id: 'live-research', session: activeTask, status: 'running' }],
    i18n,
    workIndex: indexBotWork([activeTask], true),
    onOpen() {},
  }));
  assert.match(liveMarkup, /data-session-id="live-research" data-tone="active" title="调研主流 Agent 的 ACP 支持 · 执行中"/);
  assert.match(liveMarkup, /class="bot-inline-worker-dot"/);
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
    variant: 'task',
    i18n,
    onOpen() {},
  }));
  assert.match(taskMarkup, /bot-work-panel-agent-icon.*data-executor-kind="peer"/);
  assert.match(taskMarkup, /width="16" height="16"/);

  const subagentMarkup = renderToStaticMarkup(createElement(BotWorkSessionRow, {
    session: taskSession,
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
