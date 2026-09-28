import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROGRESS_THROTTLE_MS,
  delegationEventId,
  mapDelegationEvents,
} from './event-mapper.mjs';

const SESSION = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  planId: 'plan-1',
  version: 4,
  status: 'running',
  leaves: [{ taskId: 'orient', status: 'pending' }],
};

test('eventId 由会话、种类和版本或批准号决定，重复映射得到同一批 id', () => {
  const failed = delegationEventId({ sessionId: 'session-1', kind: 'failed', version: 4 });
  assert.equal(delegationEventId({ sessionId: 'session-1', kind: 'failed', version: 4 }), failed);
  assert.notEqual(delegationEventId({ sessionId: 'session-1', kind: 'cancelled', version: 4 }), failed);
  assert.equal(
    delegationEventId({ sessionId: 'session-1', kind: 'needs_user', approvalId: 'approval-1', version: 9 }),
    delegationEventId({ sessionId: 'session-1', kind: 'needs_user', approvalId: 'approval-1', version: 1 }),
  );

  const previous = { sessions: [] };
  const current = {
    sessions: [{
      ...SESSION,
      needsUser: [{ approvalId: 'approval-1', kind: 'approval' }],
      verdict: { outcome: 'passed', version: 'v1', evidenceRefs: ['evidence-1'] },
    }],
  };
  const once = mapDelegationEvents(previous, current, { now: () => '2026-09-27T00:00:00.000Z' });
  const twice = mapDelegationEvents(previous, current, { now: () => '2026-09-27T00:00:00.000Z' });
  assert.deepEqual(twice.map((event) => event.eventId), once.map((event) => event.eventId));
  assert.deepEqual(once.map((event) => event.kind), ['session_started', 'needs_user', 'result_ready']);
  assert.equal(once[1].payload.need, 'approval');
  assert.equal(once[2].payload.outcome, 'passed');
  assert.deepEqual(once[2].payload.evidenceRefs, ['evidence-1']);
});

test('进度只在叶子新完成时发出，30 秒内再完成也先压住', () => {
  const running = { sessions: [{ ...SESSION, leaves: [{ taskId: 'scan', status: 'pending' }] }] };
  const oneDone = {
    sessions: [{
      ...SESSION,
      version: 5,
      leaves: [{ taskId: 'scan', status: 'completed' }],
      progressEmittedAt: '2026-09-27T00:00:00.000Z',
    }],
  };
  const started = mapDelegationEvents({ sessions: [] }, running, { now: () => '2026-09-27T00:00:00.000Z' });
  assert.deepEqual(started.map((event) => event.kind), ['session_started']);

  const progress = mapDelegationEvents(running, oneDone, { now: () => '2026-09-27T00:00:00.000Z' });
  assert.deepEqual(progress.map((event) => event.kind), ['progress']);
  assert.deepEqual(progress[0].payload.leafIds, ['scan']);

  const another = {
    sessions: [{
      ...oneDone.sessions[0],
      leaves: [
        { taskId: 'scan', status: 'completed' },
        { taskId: 'fix', status: 'completed' },
      ],
    }],
  };
  const throttled = mapDelegationEvents(oneDone, another, {
    now: () => '2026-09-27T00:00:10.000Z',
  });
  assert.equal(throttled.some((event) => event.kind === 'progress'), false);

  const later = mapDelegationEvents(oneDone, another, {
    now: () => new Date(Date.parse('2026-09-27T00:00:00.000Z') + PROGRESS_THROTTLE_MS).toISOString(),
  });
  assert.deepEqual(later.filter((event) => event.kind === 'progress').map((event) => event.payload.leafIds), [['fix']]);
});

test('失败、取消、中断、用户介入和停滞各有自己的事实 id', () => {
  const prior = { sessions: [{ ...SESSION }] };
  const failed = mapDelegationEvents(prior, {
    sessions: [{ ...SESSION, version: 6, status: 'failed' }],
  }, { now: () => '2026-09-27T00:00:00.000Z' });
  assert.deepEqual(failed.map((event) => event.kind), ['failed']);
  assert.equal(mapDelegationEvents({
    sessions: [{ ...SESSION, version: 6, status: 'failed' }],
  }, {
    sessions: [{ ...SESSION, version: 7, status: 'failed' }],
  }).length, 0);

  const cancelled = mapDelegationEvents(prior, {
    sessions: [{ ...SESSION, status: 'cancelled' }],
  });
  const interrupted = mapDelegationEvents(prior, {
    sessions: [{ ...SESSION, status: 'interrupted' }],
  });
  assert.equal(cancelled[0].kind, 'cancelled');
  assert.equal(interrupted[0].kind, 'interrupted');
  assert.notEqual(cancelled[0].eventId, interrupted[0].eventId);

  const intervened = mapDelegationEvents(prior, {
    sessions: [{ ...SESSION, interventions: [{ id: 'msg-9' }] }],
  });
  assert.equal(intervened[0].kind, 'user_intervened');
  assert.equal(intervened[0].payload.messageId, 'msg-9');
  assert.equal(mapDelegationEvents({
    sessions: [{ ...SESSION, interventions: [{ id: 'msg-9' }] }],
  }, {
    sessions: [{ ...SESSION, interventions: [{ id: 'msg-9' }] }],
  }).length, 0);

  const stalled = mapDelegationEvents(prior, {
    sessions: [{ ...SESSION, stallId: 'stall-1' }],
  });
  assert.equal(stalled[0].kind, 'stalled');
  assert.equal(stalled[0].version, 'stall-1');
});

test('运行满 10 分钟且没有待用户事项时发出一次停滞', () => {
  const startedAt = '2026-09-27T00:00:00.000Z';
  const now = '2026-09-27T00:10:00.000Z';
  const prior = { sessions: [{ ...SESSION, startedAt }] };
  const stalled = mapDelegationEvents(prior, prior, { now: () => now });
  assert.deepEqual(stalled.map((event) => event.kind), ['stalled']);
  assert.equal(stalled[0].version, `stall:${SESSION.sessionId}:${startedAt}`);
  assert.equal(stalled[0].payload.stallId, stalled[0].version);

  const again = mapDelegationEvents({
    sessions: [{ ...SESSION, startedAt, stallId: stalled[0].version }],
  }, prior, { now: () => '2026-09-27T00:20:00.000Z' });
  assert.equal(again.length, 0);

  const waiting = mapDelegationEvents(prior, {
    sessions: [{
      ...SESSION,
      startedAt,
      needsUser: [{ approvalId: 'question-1', kind: 'question' }],
    }],
  }, { now: () => now });
  assert.equal(waiting.some((event) => event.kind === 'stalled'), false);
  assert.equal(waiting.some((event) => event.kind === 'needs_user'), true);
});

test('失败和中断事件带上中断原因、最后错误，第三次同类失败要求问用户', () => {
  const prior = { sessions: [{ ...SESSION }] };
  const failed = mapDelegationEvents(prior, {
    sessions: [{
      ...SESSION,
      status: 'failed',
      runner: { lastError: '端口被占用', interruption: { reason: 'bind failed' } },
    }],
  }, { now: () => '2026-09-27T00:00:00.000Z' });
  assert.equal(failed[0].kind, 'failed');
  assert.equal(failed[0].payload.status, 'failed');
  assert.equal(failed[0].payload.summary, 'bind failed；端口被占用');
  assert.equal(failed[0].payload.reason, 'bind failed');
  assert.equal(failed[0].payload.lastError, '端口被占用');
  assert.equal(failed[0].payload.askUser, undefined);

  const interrupted = mapDelegationEvents(prior, {
    sessions: [{
      ...SESSION,
      status: 'interrupted',
      taskId: 'task-login',
      runner: { lastError: 'boom', interruption: { reason: 'boom' } },
      failureLog: [
        { taskId: 'task-login', cause: 'boom' },
        { taskId: 'task-login', cause: 'Boom' },
      ],
    }],
  }, { now: () => '2026-09-27T00:00:00.000Z' });
  assert.equal(interrupted[0].kind, 'interrupted');
  assert.equal(interrupted[0].payload.summary, 'boom');
  assert.equal(interrupted[0].payload.sameCauseCount, 3);
  assert.equal(interrupted[0].payload.stopAutoRetry, true);
  assert.equal(interrupted[0].payload.askUser, true);
});
