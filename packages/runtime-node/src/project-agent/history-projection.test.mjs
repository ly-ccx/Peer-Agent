import assert from 'node:assert/strict';
import test from 'node:test';

import { classicNeedsYouCount, projectClassicGoals, projectHistory } from './history-projection.mjs';

const conversations = [
  { id: 'new', title: '新的', workspacePath: '/repo', updatedAt: '2026-09-27T03:00:00.000Z', status: 'active' },
  { id: 'old', title: '旧的', workspacePath: '/repo', updatedAt: '2026-09-27T01:00:00.000Z', status: 'active' },
  { id: 'bot', title: '机器人', workspacePath: '/repo', role: 'project_agent', updatedAt: '2026-09-27T04:00:00.000Z' },
  { id: 'task', title: '任务', workspacePath: '/repo', role: 'work_session', updatedAt: '2026-09-27T05:00:00.000Z' },
  { id: 'archived', title: '归档', workspacePath: '/repo', updatedAt: '2026-09-27T06:00:00.000Z', status: 'archived' },
  { id: 'other', title: '别的仓', workspacePath: '/other', updatedAt: '2026-09-27T02:00:00.000Z' },
  { id: 'loose', title: '没有工作区', workspacePath: null, updatedAt: '2026-09-27T02:30:00.000Z' },
  { id: 'loose-old', title: '更早', workspacePath: '', updatedAt: '2026-09-27T00:30:00.000Z' },
  { id: 'loose-archived', title: '未归属归档', workspacePath: null, status: 'archived', updatedAt: '2026-09-27T07:00:00.000Z' },
];

test('历史投影按更新时间倒序，丢掉有角色的会话和归档', () => {
  const items = projectHistory(conversations, { workspacePath: '/repo' });
  assert.deepEqual(items.map((item) => item.id), ['new', 'old']);
  const withArchive = projectHistory(conversations, { workspacePath: '/repo', includeArchived: true });
  assert.deepEqual(withArchive.map((item) => item.id), ['archived', 'new', 'old']);
});

test('没有工作区的会话进未归属历史，归档仍然不在里面', () => {
  const items = projectHistory(conversations, { workspacePath: null });
  assert.deepEqual(items.map((item) => item.id), ['loose', 'loose-old']);
});

test('经典目标里等待用户的计入需要你，已结束的和任务计划不计', () => {
  const goals = projectClassicGoals([
    {
      planId: 'plan-wait',
      conversationId: 'old',
      title: '等用户',
      status: 'executing',
      targetWorkspacePath: '/repo',
      runner: { status: 'waiting_user' },
      updatedAt: '2026-09-27T01:00:00.000Z',
    },
    {
      planId: 'plan-run',
      conversationId: 'new',
      title: '还在跑',
      status: 'executing',
      originWorkspacePath: '/repo',
      tasks: [{ status: 'running', subtasks: [{ status: 'pending' }] }],
    },
    {
      planId: 'plan-done',
      title: '做完了',
      status: 'completed',
      targetWorkspacePath: '/repo',
      runner: { status: 'waiting_user' },
    },
    {
      planId: 'plan-task',
      title: '机器人任务',
      status: 'executing',
      targetWorkspacePath: '/repo',
      delegationOrigin: { sessionId: 'sess-1' },
      runner: { status: 'waiting_user' },
    },
    {
      planId: 'plan-other',
      title: '别的仓',
      status: 'executing',
      targetWorkspacePath: '/other',
      runner: { status: 'waiting_user' },
    },
    {
      planId: 'plan-by-conversation',
      conversationId: 'old',
      title: '只挂在会话上',
      status: 'paused',
      tasks: [{ status: 'pending', subtasks: [{ status: 'waiting_user' }] }],
    },
  ], { workspacePath: '/repo', conversationIds: ['old', 'new'] });
  assert.deepEqual(goals.map((goal) => goal.planId), [
    'plan-wait',
    'plan-run',
    'plan-by-conversation',
  ]);
  assert.equal(classicNeedsYouCount(goals), 2);
  assert.equal(goals.find((goal) => goal.planId === 'plan-run').waitingUser, false);
});
