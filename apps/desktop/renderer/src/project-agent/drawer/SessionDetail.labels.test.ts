import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createI18n } from '@peer-agent/i18n';
import { WORK_SESSION_STATUSES } from '@peer-agent/protocol';
import { formatDrawerSessionStatus, formatDrawerStamp, groupDrawerSessions, readDrawerSession } from '../state/drawerState.ts';
import { taskProgressPreview } from '../state/taskDetailState.ts';

// Render the actual component's read model without invoking child execution controls.
const exports: Record<string, any> = {};
const jsx = { jsx: (type: unknown, props: unknown) => ({ type, props }), jsxs: (type: unknown, props: unknown) => ({ type, props }) };
const modules: Record<string, unknown> = {
  react: { useState: (value: unknown) => [value, () => {}], useId: () => 'task-details' }, 'react/jsx-runtime': jsx,
  '@peer-agent/protocol': { WORK_SESSION_STATUSES },
  '../state/drawerState': { formatDrawerSessionStatus, formatDrawerStamp, groupDrawerSessions },
  '../state/taskDetailState': { taskProgressPreview },
  './TaskConversationButton': { TaskConversationButton: 'task-conversation-entry' },
  './ConversationScene': { ConversationSceneDrawer: 'scene' },
  '../../workbench/ResourceWorkspaceContext': { useResourceWorkspace: () => resourcePane },
  '../../app/components/MotionDetails': { MotionDetails: 'details' }, '../../ui/icons': { PeerIcon: 'icon' },
  '../state/TaskCancellation': { TaskCancelButton: 'cancel' }, './CoordinationDetails': { CoordinationDetails: 'coordination' },
  './EvidencePreview': { EvidencePreview: 'evidence' }, './TaskVerification': { TaskVerification: 'verification' },
  '../styles/bot-task-detail.css': {},
};
let resourcePane: { ready: boolean; openConversation: (value: any) => void } | null = null;
runInNewContext(ts.transpileModule(readFileSync(new URL('./SessionDetail.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText, { exports, require(id: string) { if (id in modules) return modules[id]; throw new Error(id); } });
const buttonExports: Record<string, any> = {};
runInNewContext(ts.transpileModule(readFileSync(new URL('./TaskConversationButton.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText, { exports: buttonExports, require(id: string) { if (id in modules) return modules[id]; throw new Error(id); } });
function find(node: any, className: string): any {
  if (Array.isArray(node)) return node.map(child => find(child, className)).find(Boolean);
  if (!node || typeof node !== 'object') return undefined;
  return node.props?.className === className ? node : find(node.props?.children, className);
}
function render(input: Record<string, unknown>) {
  const session = readDrawerSession({ sessionId: 's', title: 'Preserved work', statusLabel: '', ...input });
  return exports.SessionDetail({ workspaceId: 'w', workspacePath: '/synthetic', session, i18n: createI18n('zh-CN'),
    isZh: true, onBack() {}, onConversation() {}, botName: 'Peer', context: null,
    reportState: 'unavailable', hasReadReport: false, onRetryReport() {} });
}

test('native detail headers remain localized for cancelled and handoff states', () => {
  assert.equal(find(render({ status: 'cancelled' }), 'bot-task-status').props.children, '已取消');
  const tree = render({ status: 'starting', coordination: { operationId: 'handoff', action: 'handoff', phase: 'stopping', goalRevision: 2, reason: 'Continue' } });
  assert.equal(find(tree, 'bot-task-status').props.children, '正在接手');
});
test('neutral child waiting cannot erase an explicit host human gate', () => {
  assert.equal(find(render({ status: 'waiting_user' }), 'bot-task-progress-text').props.children, '等待跟进');
  for (const label of ['预算已耗尽', '等待你的选择']) {
    const tree = render({ status: 'waiting_user', statusLabel: label, followUp: { owner: 'user', inCurrentList: true, reason: 'awaiting_human_gate' } });
    assert.equal(find(tree, 'bot-task-progress-text').props.children, label);
  }
});
test('a Bot-owned result does not manufacture user acceptance in its header', () => {
  const tree = render({ status: 'result_ready', followUp: { owner: 'bot', inCurrentList: true, reason: 'awaiting_acceptance_technical' } });
  const label = find(tree, 'bot-task-status').props.children;
  assert.equal(label, createI18n('zh-CN').t('projectAgent.chat.work.resultSettling'));
  assert.notEqual(label, '结果待确认');
});

test('withdrawn history uses the host-ended follow-up copy rather than assigning work back to the Bot', () => {
  const i18n = createI18n('zh-CN');
  const tree = render({ status: 'cancelled', followUp: { owner: 'none', inCurrentList: false, reason: 'user_withdrawn' } });
  assert.equal(find(tree, 'bot-task-next').props.children[0].props.children, i18n.t('projectAgent.drawer.task.followUpEnded'));
  assert.equal(find(tree, 'bot-task-conversation').props.children[0], i18n.t('projectAgent.drawer.task.askEnded', { name: 'Peer' }));
  const pending = render({ status: 'cancelled', followUp: { owner: 'bot', inCurrentList: true, reason: 'stop_unconfirmed' } });
  assert.equal(find(pending, 'bot-task-next').props.children[0].props.children, i18n.t('projectAgent.drawer.task.followUp', { name: 'Peer' }));
});

test('opening a child scene keeps its task provenance and targets the independent resource pane', () => {
  const opened: any[] = [];
  resourcePane = { ready: true, openConversation: value => opened.push(value) };
  try {
    const tree = render({ status: 'running', conversationId: 'child', planId: 'plan' });
    buttonExports.TaskConversationButton(find(tree, 'ui-button is-primary bot-task-scene').props).props.onClick();
    assert.equal(opened.length, 1);
    assert.equal(opened[0].conversationId, 'child');
    assert.equal(opened[0].workspaceId, 'w');
    assert.deepEqual({ ...opened[0].task }, { sessionId: 's', planId: 'plan' });
    resourcePane.ready = false;
    assert.equal(buttonExports.TaskConversationButton(find(render({ conversationId: 'child' }), 'ui-button is-primary bot-task-scene').props).props.disabled, true);
  } finally { resourcePane = null; }
});

test('task details start collapsed while the complete conversation entry remains outside', () => {
  const tree = render({ status: 'running', conversationId: 'child', spawnedAt: '2026-10-29T04:13:00Z' });
  const full = find(tree, 'bot-task-full');
  assert.ok(full);
  assert.equal(full.props.hidden, true, 'task details must not start expanded');
  const toggle = find(tree, 'ui-button bot-task-full-toggle');
  assert.equal(toggle.props['aria-expanded'], false);
  assert.equal(toggle.props['aria-controls'], full.props.id);
  assert.ok(find(tree, 'ui-button is-primary bot-task-scene'));
  assert.equal(find(full, 'ui-button is-primary bot-task-scene'), undefined, 'conversation entry is not part of the hidden region');
  assert.ok(find(full, 'bot-task-next'));
  assert.ok(find(full, 'bot-task-information'));
  assert.ok(find(full, 'bot-task-created'));
  assert.ok(find(full, 'bot-task-full-content').props.children.some((child: any) => child?.type === 'cancel'));
  assert.equal(find(tree, 'bot-task-detail-meta').props.children.type, 'span', 'creation time stays out of the compact header');
});

test('direct conversation entry preserves fallback provenance and never dispatches without a target or ready pane', () => {
  const fallback: any[] = [];
  const props = find(render({ status: 'running', conversationId: 'child', planId: 'plan' }), 'ui-button is-primary bot-task-scene').props;
  const standalone = buttonExports.TaskConversationButton({ ...props, onOpenFallback: (session: any) => fallback.push(session) });
  standalone.props.onClick();
  assert.equal(fallback[0].conversationId, 'child');
  assert.equal(fallback[0].planId, 'plan');
  const absent = buttonExports.TaskConversationButton({ ...props, session: { ...props.session, conversationId: '' }, onOpenFallback() { assert.fail('missing conversation cannot navigate'); } });
  assert.equal(absent.props.disabled, true); absent.props.onClick();
  resourcePane = { ready: false, openConversation() { assert.fail('unready pane cannot navigate'); } };
  try {
    const unavailable = buttonExports.TaskConversationButton(props);
    assert.equal(unavailable.props.disabled, true); unavailable.props.onClick();
  } finally { resourcePane = null; }
});

test('the task list opens its child conversation without selecting task details first', () => {
  const listExports: Record<string, any> = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL('./TasksTab.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports: listExports, require(id: string) { if (id in modules) return modules[id]; throw new Error(id); } });
  const session = readDrawerSession({ sessionId: 's', conversationId: 'child', planId: 'plan', title: 'Preserved work', status: 'running' });
  const opened: any[] = [];
  const tree = listExports.TasksTab({ workspaceId: 'w', workspacePath: '/synthetic', sessions: [session], selectedId: null,
    i18n: createI18n('zh-CN'), onSelect() { assert.fail('conversation entry cannot select details'); },
    onOpenSession: (target: any) => opened.push(target), onOpenBot() {} });
  const entry = find(tree, 'ui-button bot-task-list-conversation');
  assert.ok(entry);
  buttonExports.TaskConversationButton(entry.props).props.onClick();
  assert.equal(opened[0].sessionId, 's');
  assert.equal(opened[0].conversationId, 'child');
});
