import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAutomationStore } from './automation-store.mjs';
import {
  automationOccurrences,
  nextAutomationOccurrence,
  parseAutomationCron,
} from './automation-schedule.mjs';
import {
  completeOnceAutomationIfNeeded,
  createAutomationScheduler,
  reconcileAutomationSchedules,
} from './automation-scheduler.mjs';

let root;
let store;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'peer-automation-scheduler-'));
  store = createAutomationStore({ storeDir: root });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function definitionInput(overrides = {}) {
  return {
    name: 'Daily CI review',
    prompt: 'Inspect failed CI.',
    workspacePath: '/tmp/workspace',
    schedule: { kind: 'daily', timezone: 'Asia/Shanghai', hour: 9, minute: 0 },
    grant: {
      preset: 'observe', workspacePath: '/tmp/workspace',
      allowedCapabilityIds: [], askCapabilityIds: [], blockedCapabilityIds: [],
      confirmedAt: '2026-08-04T00:00:00.000Z', version: 1,
    },
    notifications: { needsAttention: 'system_and_badge', failed: true, succeeded: false },
    budget: { timeoutMs: 3_600_000 },
    missedRunPolicy: 'run_latest', overlapPolicy: 'skip', status: 'active',
    ...overrides,
  };
}

function createDefinition(overrides = {}) {
  return store.createDefinition(definitionInput(overrides), {
    automationId: overrides.automationId || 'automation-1',
    now: overrides.createdAt || '2026-08-04T00:00:00.000Z',
  });
}

test('calculates timezone-aware future occurrences and minute cron', () => {
  const schedule = { kind: 'weekdays', timezone: 'Asia/Shanghai', hour: 9, minute: 0 };
  assert.deepEqual(automationOccurrences(schedule, { after: '2026-08-07T02:00:00.000Z', count: 3 }), [
    '2026-08-10T01:00:00.000Z',
    '2026-08-11T01:00:00.000Z',
    '2026-08-12T01:00:00.000Z',
  ]);
  assert.deepEqual([...parseAutomationCron('*/15 8-9 * * 1-5').minutes], [0, 15, 30, 45]);
  assert.equal(nextAutomationOccurrence(
    { kind: 'custom_cron', timezone: 'UTC', cron: '*/15 8-9 * * 1-5' },
    '2026-08-10T08:01:00.000Z',
  ), '2026-08-10T08:15:00.000Z');
  assert.throws(() => parseAutomationCron('* * * * * *'), /exactly five fields/);
});

test('creates only the latest missed occurrence and remains idempotent', () => {
  createDefinition();
  const first = reconcileAutomationSchedules({ store, now: '2026-08-06T02:00:00.000Z' });
  assert.equal(first.createdRunIds.length, 1);
  const run = store.getRun(first.createdRunIds[0]);
  assert.equal(run.scheduledAt, '2026-08-06T01:00:00.000Z');
  assert.equal(run.missedRecovery, true);
  const second = reconcileAutomationSchedules({ store, now: '2026-08-06T02:00:00.000Z' });
  assert.deepEqual(second.createdRunIds, []);
  assert.equal(store.listRuns({ automationId: 'automation-1' }).length, 1);
});

test('skip missed policy records a skipped run without starting the runner', () => {
  createDefinition({ missedRunPolicy: 'skip' });
  const ready = [];
  const result = reconcileAutomationSchedules({
    store, now: '2026-08-05T03:00:00.000Z', onRunReady: (run) => ready.push(run.runId),
  });
  assert.deepEqual(ready, []);
  assert.equal(result.skippedRunIds.length, 1);
  assert.equal(store.getRun(result.skippedRunIds[0]).skippedReason, 'missed_policy');
});

test('overlap policy skips a due occurrence when an active run exists', () => {
  const definition = createDefinition();
  store.createRun({
    automationId: definition.automationId,
    idempotencyKey: 'manual:run-1', triggerSource: 'manual', status: 'running',
    scheduledAt: '2026-08-04T00:30:00.000Z',
    snapshot: {
      definitionVersion: 1, name: definition.name, prompt: definition.prompt,
      workspacePath: definition.workspacePath, schedule: definition.schedule,
      grant: definition.grant, budget: definition.budget,
    },
  }, { runId: 'run-active', now: '2026-08-04T00:30:00.000Z' });
  const result = reconcileAutomationSchedules({ store, now: '2026-08-05T02:00:00.000Z' });
  assert.equal(result.skippedRunIds.length, 1);
  assert.equal(store.getRun(result.skippedRunIds[0]).skippedReason, 'overlap');
});

test('global pause suppresses catch-up and resume starts from the resume instant', () => {
  createDefinition();
  store.setRuntimeState({ globallyPaused: true, pausedAt: '2026-08-04T00:30:00.000Z' }, {
    now: '2026-08-04T00:30:00.000Z',
  });
  reconcileAutomationSchedules({ store, now: '2026-08-06T02:00:00.000Z' });
  assert.equal(store.listRuns().length, 0);

  // Global resume advances the schedule cursor, so the pause window is not treated as downtime.
  const scheduler = createAutomationScheduler({
    store,
    clock: () => Date.parse('2026-08-06T02:00:00.000Z'),
    scheduleTimer: () => 1,
    cancelTimer: () => {},
  });
  scheduler.setGloballyPaused(false);
  assert.equal(store.listRuns().length, 0);
  assert.equal(store.getDefinition('automation-1').lastScheduledAt, '2026-08-06T02:00:00.000Z');
});

test('one-time schedule becomes completed when its run reaches terminal state', () => {
  const definition = createDefinition({
    schedule: { kind: 'once', timezone: 'UTC', onceAt: '2026-08-05T09:00:00.000Z' },
  });
  const result = reconcileAutomationSchedules({ store, now: '2026-08-05T09:00:00.000Z' });
  const run = store.updateRun(result.createdRunIds[0], {
    status: 'succeeded', finishedAt: '2026-08-05T09:05:00.000Z',
  });
  completeOnceAutomationIfNeeded(store, run, { now: '2026-08-05T09:05:00.000Z' });
  assert.equal(store.getDefinition(definition.automationId).status, 'completed');
});

test('scheduler arms from persisted nextRunAt and reconciles on resume', () => {
  const definition = createDefinition();
  store.updateDefinitionRuntimeFacts(definition.automationId, {
    lastScheduledAt: '2026-08-04T01:00:00.000Z', nextRunAt: '2026-08-05T01:00:00.000Z',
  }, { now: '2026-08-04T02:00:00.000Z' });
  const scheduled = [];
  const scheduler = createAutomationScheduler({
    store,
    clock: () => Date.parse('2026-08-04T02:00:00.000Z'),
    scheduleTimer: (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length; },
    cancelTimer: () => {},
  });
  scheduler.start();
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 23 * 60 * 60 * 1000);
  assert.equal(scheduler.handleResume().reason, 'resume');
  scheduler.stop();
});
