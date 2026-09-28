import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SAME_CAUSE_RETRY_LIMIT,
  STALL_WINDOW_MS,
  assessSameCause,
  assessStall,
  delegationFactsForWorkspace,
  describeFailure,
  watchFactsFromPlan,
} from './watchdog.mjs';

const STARTED = '2026-09-27T00:00:00.000Z';
const TEN_MINUTES = new Date(Date.parse(STARTED) + STALL_WINDOW_MS).toISOString();

function running(extra = {}) {
  return {
    sessionId: 'session-1',
    status: 'running',
    startedAt: STARTED,
    ...extra,
  };
}

test('运行满 10 分钟且没有进展才算停滞，差一秒或还在等用户都不算', () => {
  const almost = new Date(Date.parse(STARTED) + STALL_WINDOW_MS - 1).toISOString();
  assert.equal(assessStall(running(), { now: almost }).stalled, false);
  const stalled = assessStall(running(), { now: TEN_MINUTES });
  assert.equal(stalled.stalled, true);
  assert.equal(stalled.stallId, `stall:session-1:${STARTED}`);
  assert.equal(assessStall(running(), { now: new Date(TEN_MINUTES) }).stallId, stalled.stallId);

  const progressed = assessStall(running({
    lastProgressAt: '2026-09-27T00:05:00.000Z',
  }), { now: TEN_MINUTES });
  assert.equal(progressed.stalled, false);
  assert.equal(progressed.anchor, '2026-09-27T00:05:00.000Z');

  const idleAfterProgress = assessStall(running({
    lastProgressAt: 'not-a-date',
    progressEmittedAt: STARTED,
  }), { now: TEN_MINUTES });
  assert.equal(idleAfterProgress.stalled, true);
  assert.equal(idleAfterProgress.stallId, `stall:session-1:${STARTED}`);

  assert.equal(assessStall(running({ status: 'waiting_user' }), { now: TEN_MINUTES }).stalled, false);
  assert.equal(assessStall(running({
    needsUser: [{ approvalId: 'approval-1', kind: 'approval' }],
  }), { now: TEN_MINUTES }).stalled, false);
  assert.equal(assessStall(running({
    needsUser: [{ approvalId: 'question-1', kind: 'question' }],
  }), { now: TEN_MINUTES }).waiting, true);
  assert.equal(assessStall(running({
    needsUser: [{ approvalId: 'plan-1', kind: 'plan_approval' }],
  }), { now: TEN_MINUTES }).stalled, false);
  assert.equal(assessStall(running({ status: 'executing' }), { now: TEN_MINUTES }).stalled, false);
  assert.equal(assessStall({ sessionId: 'session-1', status: 'running' }, { now: TEN_MINUTES }).stalled, false);
});

test('失败摘要带上 GoalPlan 中断原因和最后错误', () => {
  const described = describeFailure({
    interruption: { reason: 'goal stopped' },
    lastError: 'enoent',
  });
  assert.equal(described.summary, 'goal stopped；enoent');
  assert.equal(described.reason, 'goal stopped');
  assert.equal(described.lastError, 'enoent');
  assert.equal(described.cause, 'goal stopped');

  const fromRunner = describeFailure({
    runner: {
      interruption: { reason: 'boom' },
      lastError: 'boom',
    },
  });
  assert.equal(fromRunner.summary, 'boom');
  assert.equal(fromRunner.cause, 'boom');

  const blocked = describeFailure({ blockedReason: 'Bind  Failed' });
  assert.equal(blocked.summary, 'Bind  Failed');
  assert.equal(blocked.cause, 'bind failed');
  assert.equal(describeFailure({ status: 'failed' }).summary, '');
});

test('同一任务同一原因满 3 次才停止自动重试，不同原因另计', () => {
  assert.equal(SAME_CAUSE_RETRY_LIMIT, 3);
  const session = {
    sessionId: 'session-1',
    taskId: 'task-login',
    runner: { interruption: { reason: 'boom' }, lastError: '端口被占用' },
    failureLog: [
      { taskId: 'task-login', cause: 'boom' },
      { taskId: 'task-login', cause: '  BOOM ' },
      { taskId: 'task-other', cause: 'boom' },
      { taskId: 'task-login', cause: 'timeout' },
    ],
  };
  const third = assessSameCause(session);
  assert.equal(third.count, 3);
  assert.equal(third.askUser, true);
  assert.equal(third.stopAutoRetry, true);

  const twice = assessSameCause({
    ...session,
    failureLog: [{ taskId: 'task-login', cause: 'boom' }],
  });
  assert.equal(twice.count, 2);
  assert.equal(twice.askUser, false);
  assert.equal(twice.stopAutoRetry, false);

  const otherCause = assessSameCause({
    sessionId: 'session-1',
    taskId: 'task-login',
    runner: { lastError: 'timeout' },
    failureLog: [
      { taskId: 'task-login', cause: 'boom' },
      { taskId: 'task-login', cause: 'boom' },
    ],
  });
  assert.equal(otherCause.count, 1);
  assert.equal(otherCause.askUser, false);
  assert.equal(assessSameCause({ sessionId: 'session-1', status: 'failed' }).count, 0);
});

test('计划上的重试记录和等待用户会进入同一套判断', () => {
  const runningPlan = watchFactsFromPlan({
    planId: 'plan-1',
    status: 'executing',
    createdAt: STARTED,
    delegationOrigin: { sessionId: 'session-1', workspaceId: 'ws-1', phase: 'running' },
    runner: { status: 'running' },
    tasks: [
      { taskId: 'orient', status: 'pending' },
      {
        taskId: 'scan',
        status: 'completed',
        updatedAt: '2026-09-27T00:05:00.000Z',
        subtasks: [],
      },
    ],
  });
  assert.equal(runningPlan.status, 'running');
  assert.equal(runningPlan.lastProgressAt, '2026-09-27T00:05:00.000Z');
  assert.equal(assessStall(runningPlan, { now: TEN_MINUTES }).stalled, false);

  const waiting = watchFactsFromPlan({
    planId: 'plan-1',
    status: 'executing',
    createdAt: STARTED,
    delegationOrigin: { sessionId: 'session-1', workspaceId: 'ws-1', phase: 'running' },
    runner: { status: 'waiting_user' },
  });
  assert.equal(waiting.status, 'waiting_user');
  assert.equal(waiting.needsUser[0].kind, 'question');
  assert.equal(assessStall(waiting, { now: TEN_MINUTES }).stalled, false);

  const failed = watchFactsFromPlan({
    planId: 'plan-1',
    status: 'interrupted',
    createdAt: STARTED,
    delegationOrigin: { sessionId: 'session-1', workspaceId: 'ws-1', phase: 'running' },
    runner: {
      status: 'failed',
      lastError: 'boom',
      interruption: { source: 'runGoalTurn', reason: 'boom', interruptedAt: STARTED },
      recoverableInterruptionCount: 2,
    },
    runTrace: {
      events: [
        { type: 'step_failed', payload: { reason: 'boom' } },
        { type: 'network_interrupted', payload: { reason: 'boom' } },
        { type: 'problem_found', payload: { message: 'boom', reason: 'runGoalTurn' } },
      ],
    },
  });
  assert.equal(failed.status, 'interrupted');
  const third = assessSameCause(failed);
  assert.equal(third.count, 3);
  assert.equal(third.askUser, true);

  const other = assessSameCause(watchFactsFromPlan({
    planId: 'plan-1',
    status: 'interrupted',
    delegationOrigin: { sessionId: 'session-1', workspaceId: 'ws-1', phase: 'running' },
    runner: {
      status: 'failed',
      lastError: 'boom',
      interruption: { reason: 'boom' },
      recoverableInterruptionCount: 2,
    },
    runTrace: {
      events: [
        { type: 'step_failed', payload: { reason: 'timeout' } },
        { type: 'step_failed', payload: { reason: 'timeout' } },
      ],
    },
  }));
  assert.equal(other.count, 1);
  assert.equal(other.askUser, false);

  const fromCount = assessSameCause({
    sessionId: 'session-1',
    planId: 'plan-1',
    runner: {
      lastError: 'boom',
      interruption: { reason: 'boom' },
      recoverableInterruptionCount: 2,
    },
  });
  assert.equal(fromCount.count, 3);
  assert.equal(fromCount.askUser, true);

  const facts = delegationFactsForWorkspace([
    {
      planId: 'plan-other',
      delegationOrigin: { sessionId: 'session-other', workspaceId: 'ws-other', phase: 'running' },
      status: 'executing',
    },
    {
      planId: 'plan-1',
      status: 'executing',
      createdAt: STARTED,
      delegationOrigin: { sessionId: 'session-1', workspaceId: 'ws-1', phase: 'running' },
    },
  ], 'ws-1');
  assert.deepEqual(facts.sessions.map((session) => session.sessionId), ['session-1']);
});
