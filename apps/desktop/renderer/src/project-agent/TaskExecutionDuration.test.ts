import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { createI18n } from '@peer-agent/i18n';
import type { TaskWorkspaceViewProps } from './task-workspace/TaskWorkspaceView.tsx';
import { readDrawerSession } from './state/drawerState.ts';

const sourceRoot = new URL('./', import.meta.url).href;
const workspace = new URL('task-workspace/TaskWorkspaceView.tsx', sourceRoot).href;
const workingPlanStrip = new URL('task-workspace/TaskWorkingPlanStrip.tsx', sourceRoot).href;
const stubs: Record<string, string> = {
  '../../clientApi': 'export const clientApi = {};',
  '../../ui/icons': 'export const PeerIcon = () => null;',
  '../../app/hooks/useCompositionGuard': 'export const useCompositionGuard = () => ({});',
  '../BotAccessControl': 'export const BotAccessControl = () => null;',
  '../state/useTaskReport': "export const useTaskReport = () => ({ detail: null, state: 'ready', refresh() {} });",
  '../state/TaskCancellation': 'export const useTaskCancellation = () => null;',
  '../conversation/ComposerTouchBar': 'export const ComposerTouchBar = () => null;',
  '../drawer/ConversationScene': 'export const ConversationSceneDrawer = () => null;',
  './TaskEvidenceInspector': 'export const TaskEvidenceInspector = () => null;',
};
// Node's test runner strips .ts types but does not transform JSX. Keep the
// workspace and sidebar real while isolating unrelated Electron/DOM surfaces.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const workspaceDependency = context.parentURL === workspace || context.parentURL === workingPlanStrip;
    if (workspaceDependency && (stubs[specifier] || specifier.endsWith('.css'))) {
      return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(stubs[specifier] || '')}` };
    }
    if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith('.')) {
      for (const extension of ['.ts', '.tsx']) {
        const url = new URL(specifier + extension, context.parentURL);
        if (existsSync(url)) return { shortCircuit: true, url: url.href };
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith(sourceRoot) && url.endsWith('.tsx')) {
      const input = readFileSync(new URL(url), 'utf8');
      return { format: 'module', shortCircuit: true, source: ts.transpileModule(input, {
        fileName: url, compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
      }).outputText };
    }
    return nextLoad(url, context);
  },
});
const { TaskWorkspaceView } = await import('./task-workspace/TaskWorkspaceView.tsx');
const { BotSidebarTasks } = await import('./BotSidebarTasks.tsx');
hooks.deregister();

const i18n = createI18n('zh-CN');
const start = '2026-11-26T00:02:00Z';
const spawnedAt = '2026-11-26T00:00:00Z';
const title = '很长的子任务标题'.repeat(18);
const noop = () => {};
function renderWorkspace(status: string, startedAt?: string, endedAt?: string) {
  const session = readDrawerSession({
    sessionId: 'task', title, status, spawnedAt, startedAt, endedAt, followUpEpoch: 1,
    workingPlan: {
      epoch: 1, revision: 1, updatedAt: start, completed: 0, total: 1, blocked: 0,
      steps: [{ title: '核对记录', status: 'in_progress' }],
    },
  });
  assert.ok(session);
  return renderToStaticMarkup(createElement(TaskWorkspaceView, {
    workspaceId: 'ws', workspacePath: '/ws', profile: { displayName: 'Peer' } as TaskWorkspaceViewProps['profile'],
    sessionId: 'task', liveSession: session, sessionsAvailable: true, context: null,
    inspectorOpen: false, inspectorTriggerRef: createRef<HTMLElement>(), i18n, isZh: true,
    onToggleInspector: noop, onCloseInspector: noop, onBackToBot: noop, onTaskConversation: noop, onOpenTask: noop,
    onCiteToBot: noop, onRefreshSessions: async () => {},
  }));
}

test('workspace puts the live or settled duration between status and title, not in the queued or legacy strip', (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2026-11-26T01:07:12Z'));
  const running = renderWorkspace('running', start);
  assert.match(running, /bot-task-status-pill.*<span class="bot-task-strip-duration"[^>]*>1:05:12<\/span><h1[^>]*tabindex="-1"[^>]*class="bot-task-strip-title"/s);
  assert.match(running, /class="bot-task-meta-text">[^<]+<\/span>/);
  assert.match(running, /class="bot-working-plan-preview"[^>]*>核对记录<\/span>/);
  assert.match(renderWorkspace('accepted', start, '2026-11-26T01:07:12Z'), /bot-task-strip-duration[^>]*>1 小时 05 分<\/span>/);
  const queued = renderWorkspace('queued');
  assert.match(queued, /bot-task-status-pill[^>]*title="发起：/);
  assert.doesNotMatch(queued, /bot-task-strip-duration/);
  assert.doesNotMatch(renderWorkspace('running'), /bot-task-strip-duration/);
});

test('sidebar duration follows the long title and renders for running rows with a known start only', (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2026-11-26T01:07:12Z'));
  const row = (status: string, id: string, startedAt?: string, endedAt?: string) => ({
    sessionId: id, title, status, updatedAt: '', startedAt, endedAt,
  });
  const html = renderToStaticMarkup(createElement(BotSidebarTasks, {
    workspaceId: 'ws', botName: 'Peer', tasks: [row('running', 'live', start), row('queued', 'queued', start),
      row('accepted', 'accepted', start, '2026-11-26T00:02:42Z'), row('running', 'legacy')],
    total: 4, activeSessionId: null, expandedMore: false, i18n, onOpenTask: noop, onToggleMore: noop,
  }));
  const rows = Array.from(html.matchAll(/<button[^>]*data-session-id="([^"]+)"[^>]*>(.*?)<\/button>/gs));
  assert.deepEqual(rows.map((match) => match[1]), ['live', 'queued', 'accepted', 'legacy']);
  assert.match(rows[0][2], /bot-sidebar-task-title[^>]*>[^<]+<\/span><span class="bot-sidebar-task-duration">1h 05m<\/span>$/);
  for (const [, , content] of rows.slice(1)) assert.doesNotMatch(content, /bot-sidebar-task-duration/);
});

test('style and refresh contracts keep labels visible and timers local', () => {
  const source = (path: string) => readFileSync(new URL(path, sourceRoot), 'utf8');
  for (const [path, selector] of [['styles/bot-task-workspace.css', 'bot-task-strip'], ['styles/bot-list.css', 'bot-sidebar-task']]) {
    const css = source(path);
    const duration = css.match(new RegExp(`\\.${selector}-duration \\{([^}]+)\\}`))?.[1] ?? '';
    assert.match(duration, /font-variant-numeric:\s*tabular-nums/);
    assert.match(duration, /flex-shrink:\s*0/);
    assert.match(duration, /white-space:\s*nowrap/);
    assert.match(css, new RegExp(`\\.${selector}-title \\{[^}]*text-overflow:\\s*ellipsis`));
  }
  const sidebarCss = source('styles/bot-list.css');
  const sidebarColumns = sidebarCss.match(/\.bot-sidebar-task \{[^}]*grid-template-columns:\s*([^;]+);/)?.[1];
  const timedColumns = sidebarCss.match(/\.bot-sidebar-task:has\(> \.bot-sidebar-task-duration\) \{[^}]*grid-template-columns:\s*([^;]+);/)?.[1];
  assert.ok(sidebarColumns);
  assert.equal(timedColumns, `${sidebarColumns} max-content`);
  const timer = source('TaskExecutionDuration.tsx');
  assert.match(timer, /function LiveExecutionDuration[\s\S]*?\? 1000 : 15000/);
  assert.match(timer, /clearInterval\(timer\)/);
  assert.match(timer, /isExecutionTicking\(timing\)\s*\? <LiveExecutionDuration/);
});
