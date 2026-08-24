import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyGoalHistoryStatus,
  collectGoalFilePaths,
  goalDiffRange,
  projectTaskGoalHistory,
  summarizeGoalOutcome,
} from './taskGoalHistory.ts';

test('projectTaskGoalHistory skips drafting siblings and keeps chronological order', () => {
  const rows = projectTaskGoalHistory([
    {
      planId: 'later',
      title: '后做的',
      status: 'completed',
      createdAt: '2026-08-22T12:00:00.000Z',
      successCriteria: [{ id: 'c1', description: '闸门能挡住无证据完成' }],
      criterionResults: [{ criterionId: 'c1', passed: true }],
    },
    {
      planId: 'draft',
      title: '没开跑',
      status: 'drafting',
      createdAt: '2026-08-22T11:00:00.000Z',
    },
    {
      planId: 'earlier',
      title: '先做的',
      goal: '先把入口改成查看进度',
      status: 'completed',
      createdAt: '2026-08-22T10:00:00.000Z',
      resultAcceptance: { acceptedAt: '2026-08-22T11:00:00.000Z' },
      tasks: [{ title: '改工作台文案', status: 'completed', involvedFiles: ['GlobalWorkbenchPage.tsx'] }],
    },
  ], 'later');

  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.planId), ['earlier', 'later']);
  assert.equal(rows[0]?.isCurrent, false);
  assert.equal(rows[0]?.status, 'archived');
  assert.equal(rows[0]?.outcome, '改工作台文案');
  assert.deepEqual(rows[0]?.files, ['GlobalWorkbenchPage.tsx']);
  assert.equal(rows[1]?.isCurrent, true);
  assert.equal(rows[1]?.status, 'ready');
  assert.equal(rows[1]?.outcome, '闸门能挡住无证据完成');
});

test('summarizeGoalOutcome prefers passed criteria over goal text', () => {
  assert.equal(
    summarizeGoalOutcome({
      planId: 'p',
      goal: '不要用这段',
      successCriteria: [
        { id: 'a', description: '已过' },
        { id: 'b', description: '没过' },
      ],
      criterionResults: [
        { criterionId: 'a', passed: true },
        { criterionId: 'b', passed: false },
      ],
    }),
    '已过',
  );
  assert.equal(
    summarizeGoalOutcome({
      planId: 'p',
      goal: '回退到目标文本',
      successCriteria: [{ id: 'a', description: '没对照' }],
      criterionResults: [],
    }),
    '回退到目标文本',
  );
});

test('collectGoalFilePaths walks nested tasks and goalDiffRange reads the delivery binding', () => {
  assert.deepEqual(
    collectGoalFilePaths({
      planId: 'p',
      involvedFiles: ['a.ts'],
      tasks: [{
        involvedFiles: ['b.ts'],
        subtasks: [{ involvedFiles: ['a.ts', 'c.ts'] }],
      }],
    }),
    ['a.ts', 'b.ts', 'c.ts'],
  );
  assert.deepEqual(
    goalDiffRange({
      planId: 'p',
      deliveryBinding: {
        targetWorkspacePath: '/repo',
        baseCommit: 'abc',
        taskBranch: 'feat/one',
      },
    }),
    { workspaceRoot: '/repo', fromRef: 'abc', toRef: 'feat/one' },
  );
  assert.equal(classifyGoalHistoryStatus({ planId: 'p', status: 'executing' }), 'running');
});
