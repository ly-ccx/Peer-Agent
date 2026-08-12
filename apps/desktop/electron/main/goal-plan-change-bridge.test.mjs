import assert from 'node:assert/strict';
import test from 'node:test';

import { bindExternalGoalPlanChanges } from './goal-plan-change-bridge.mjs';

test('bindExternalGoalPlanChanges broadcasts external persisted changes and ignores local writes', () => {
  let listener = null;
  let stopped = false;
  const broadcasts = [];
  const notifications = [];
  const stop = bindExternalGoalPlanChanges({
    currentPid: 42,
    goalPlanStore: {
      subscribeChanges(nextListener) {
        listener = nextListener;
        return () => { stopped = true; };
      },
    },
    broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    getTaskNotificationBroker: () => ({
      handleGoalPlanChanged: (payload) => notifications.push(payload),
    }),
  });

  listener({ writerPid: 42, conversationId: 'same-process' });
  listener({
    writerPid: 99,
    reason: 'persist',
    planId: 'plan-cli',
    conversationId: 'conversation-cli',
    changeKind: 'runner-state',
    runner: { status: 'running' },
  });

  assert.deepEqual(broadcasts, [{
    channel: 'goalPlans:changed',
    payload: {
      reason: 'persist',
      planId: 'plan-cli',
      conversationId: 'conversation-cli',
      changeKind: 'runner-state',
      runner: { status: 'running' },
    },
  }]);
  assert.deepEqual(notifications, [broadcasts[0].payload]);
  stop();
  assert.equal(stopped, true);
});

test('bindExternalGoalPlanChanges default error reporting survives a broken stderr pipe', () => {
  let listener = null;
  const originalWarn = console.warn;
  console.warn = () => {
    const error = new Error('write EPIPE');
    error.code = 'EPIPE';
    throw error;
  };
  try {
    bindExternalGoalPlanChanges({
      currentPid: 1,
      goalPlanStore: {
        subscribeChanges(nextListener) {
          listener = nextListener;
          return () => {};
        },
      },
      broadcast: () => {},
      getTaskNotificationBroker: () => ({
        handleGoalPlanChanged() { throw new Error('notification failed'); },
      }),
    });

    assert.doesNotThrow(() => {
      listener({ writerPid: 2, planId: 'plan-external' });
    });
  } finally {
    console.warn = originalWarn;
  }
});

test('bindExternalGoalPlanChanges keeps panel refresh alive when notification delivery fails', () => {
  let listener = null;
  const broadcasts = [];
  const errors = [];
  bindExternalGoalPlanChanges({
    currentPid: 1,
    goalPlanStore: {
      subscribeChanges(nextListener) {
        listener = nextListener;
        return () => {};
      },
    },
    broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    getTaskNotificationBroker: () => ({
      handleGoalPlanChanged() { throw new Error('notification failed'); },
    }),
    onError: (error) => errors.push(error.message),
  });

  listener({ writerPid: 2, planId: 'plan-external', conversationId: 'conversation-external' });

  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].channel, 'goalPlans:changed');
  assert.equal(broadcasts[0].payload.conversationId, 'conversation-external');
  assert.deepEqual(errors, ['notification failed']);
});
