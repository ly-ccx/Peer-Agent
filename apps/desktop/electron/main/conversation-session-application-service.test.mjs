import assert from 'node:assert/strict';
import test from 'node:test';
import { createConversationSessionApplicationService } from './conversation-session-application-service.mjs';

function createHarness(overrides = {}) {
  const calls = [];
  const scheduled = [];
  const activeGoal = {
    planId: 'plan-active',
    runner: { enabled: true, status: 'running' },
  };
  const ports = {
    getActiveGoalByConversation: (conversationId) => {
      calls.push(['get-active-goal', conversationId]);
      return activeGoal;
    },
    shouldRecoverGoal: (plan) => {
      calls.push(['should-recover', plan]);
      return true;
    },
    scheduleRecovery: (task) => {
      calls.push(['schedule-recovery']);
      scheduled.push(task);
    },
    startGoalRunner: (planId) => {
      calls.push(['start-goal-runner', planId]);
      return Promise.resolve();
    },
    markTaskRead: (planId) => {
      calls.push(['mark-task-read', planId]);
    },
    reportRecoveryFailure: (error) => {
      calls.push(['report-recovery-failure', error]);
    },
    reportNotificationFailure: (error) => {
      calls.push(['report-notification-failure', error]);
    },
    ...overrides,
  };

  return {
    calls,
    scheduled,
    service: createConversationSessionApplicationService(ports),
  };
}

test('setActiveConversation normalizes ids, exposes the active state, and preserves side-effect ordering', async () => {
  const { calls, scheduled, service } = createHarness();

  assert.deepEqual(
    service.setActiveConversation({ conversationId: '  conversation-1  ', planId: '  plan-read  ' }),
    { ok: true, conversationId: 'conversation-1' },
  );
  assert.equal(service.getActiveConversationId(), 'conversation-1');
  assert.deepEqual(calls, [
    ['get-active-goal', 'conversation-1'],
    ['should-recover', {
      planId: 'plan-active',
      runner: { enabled: true, status: 'running' },
    }],
    ['schedule-recovery'],
    ['mark-task-read', 'plan-read'],
  ]);
  assert.equal(scheduled.length, 1);

  scheduled[0]();
  await Promise.resolve();
  assert.deepEqual(calls.at(-1), ['start-goal-runner', 'plan-active']);
});

test('clearing the active conversation skips Goal and notification side effects', () => {
  const { calls, scheduled, service } = createHarness();

  service.setActiveConversation({ conversationId: 'conversation-1' });
  calls.length = 0;
  scheduled.length = 0;

  assert.deepEqual(service.setActiveConversation({ conversationId: '   ', planId: 'plan-read' }), {
    ok: true,
    conversationId: null,
  });
  assert.equal(service.getActiveConversationId(), null);
  assert.deepEqual(calls, []);
  assert.deepEqual(scheduled, []);
});

test('a non-recoverable Goal is not scheduled while a valid task is still marked read', () => {
  const { calls, scheduled, service } = createHarness({
    shouldRecoverGoal: (plan) => {
      calls.push(['should-recover', plan]);
      return false;
    },
  });

  assert.deepEqual(service.setActiveConversation({ conversationId: 'conversation-1', planId: 'plan-read' }), {
    ok: true,
    conversationId: 'conversation-1',
  });
  assert.equal(scheduled.length, 0);
  assert.deepEqual(calls.at(-1), ['mark-task-read', 'plan-read']);
});

test('an asynchronous Goal recovery failure is reported without changing active state', async () => {
  const recoveryError = new Error('recovery failed');
  const { calls, scheduled, service } = createHarness({
    startGoalRunner: (planId) => {
      calls.push(['start-goal-runner', planId]);
      return Promise.reject(recoveryError);
    },
  });

  service.setActiveConversation({ conversationId: 'conversation-1' });
  scheduled[0]();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(service.getActiveConversationId(), 'conversation-1');
  assert.deepEqual(calls.at(-1), ['report-recovery-failure', recoveryError]);
});

test('notification failures are contained and reported with the legacy success result', () => {
  const notificationError = new Error('read failed');
  const { calls, service } = createHarness({
    markTaskRead: (planId) => {
      calls.push(['mark-task-read', planId]);
      throw notificationError;
    },
  });

  assert.deepEqual(service.setActiveConversation({ conversationId: 'conversation-1', planId: 'plan-read' }), {
    ok: true,
    conversationId: 'conversation-1',
  });
  assert.deepEqual(calls.at(-1), ['report-notification-failure', notificationError]);
});

test('invalid plan ids do not invoke the notification port', () => {
  const { calls, service } = createHarness();

  service.setActiveConversation({ conversationId: 'conversation-1', planId: 42 });

  assert.equal(calls.some(([name]) => name === 'mark-task-read'), false);
});

test('opening a conversation marks conversation read when port is provided', () => {
  const { calls, service } = createHarness({
    markConversationRead: (conversationId) => {
      calls.push(['mark-conversation-read', conversationId]);
    },
  });

  service.setActiveConversation({ conversationId: 'conversation-1', planId: 'plan-read' });

  assert.equal(
    calls.some(([name, id]) => name === 'mark-conversation-read' && id === 'conversation-1'),
    true,
  );
  assert.equal(
    calls.some(([name, id]) => name === 'mark-task-read' && id === 'plan-read'),
    true,
  );
});
