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

test('bindExternalGoalPlanChanges coalesces external runner-progress bursts', () => {
  let listener = null;
  const broadcasts = [];
  /** @type {Array<{ id: number, ms: number, fn: Function }>} */
  const timers = [];
  let nextTimerId = 1;
  let now = 1_000;

  const stop = bindExternalGoalPlanChanges({
    currentPid: 1,
    runnerProgressMinIntervalMs: 1000,
    timers: {
      setTimeout(fn, ms) {
        const id = nextTimerId;
        nextTimerId += 1;
        timers.push({ id, ms, fn });
        return id;
      },
      clearTimeout(id) {
        const index = timers.findIndex((timer) => timer.id === id);
        if (index >= 0) timers.splice(index, 1);
      },
    },
    goalPlanStore: {
      subscribeChanges(nextListener) {
        listener = nextListener;
        return () => {};
      },
    },
    broadcast: (channel, payload) => broadcasts.push({ channel, payload, at: now }),
    getTaskNotificationBroker: () => ({
      handleGoalPlanChanged() {},
    }),
  });

  listener({
    writerPid: 99,
    planId: 'plan-1',
    conversationId: 'conversation-1',
    changeKind: 'runner-progress',
    runner: { status: 'running', phase: 'act', ticks: 1 },
  });
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].payload.runner.ticks, 1);

  listener({
    writerPid: 99,
    planId: 'plan-1',
    conversationId: 'conversation-1',
    changeKind: 'runner-progress',
    runner: { status: 'running', phase: 'act', ticks: 2 },
  });
  listener({
    writerPid: 99,
    planId: 'plan-1',
    conversationId: 'conversation-1',
    changeKind: 'runner-progress',
    runner: { status: 'running', phase: 'act', ticks: 3 },
  });
  assert.equal(broadcasts.length, 1);
  assert.equal(timers.length, 1);

  const due = timers.shift();
  now += due.ms;
  due.fn();
  assert.equal(broadcasts.length, 2);
  assert.equal(broadcasts[1].payload.runner.ticks, 3);

  // Hard change flushes immediately and cancels pending soft progress.
  listener({
    writerPid: 99,
    planId: 'plan-1',
    conversationId: 'conversation-1',
    changeKind: 'runner-progress',
    runner: { status: 'running', phase: 'act', ticks: 4 },
  });
  assert.equal(timers.length, 1);
  listener({
    writerPid: 99,
    planId: 'plan-1',
    conversationId: 'conversation-1',
    changeKind: 'persist',
    reason: 'update-task',
  });
  assert.equal(timers.length, 0);
  assert.equal(broadcasts.at(-1).payload.changeKind, 'persist');

  stop();
});


test('main onChange skips overview refresh for runner-progress', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('./main.mjs', import.meta.url), 'utf8');
  assert.match(
    source,
    /if \(payload\?\.changeKind !== 'runner-progress'\) \{[\s\S]*?taskOverviewBroadcast\.request\(/,
  );
  assert.match(
    source,
    /if \(payload\?\.changeKind === 'runner-progress'\) \{\s*return;\s*\}/s,
  );
});
