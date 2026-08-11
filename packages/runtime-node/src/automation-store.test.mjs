import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAutomationStore } from './automation-store.mjs';

let root;
let store;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'peer-automation-store-'));
  store = createAutomationStore({ storeDir: root });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function definitionInput(overrides = {}) {
  return {
    name: 'Daily CI review',
    prompt: 'Inspect failed CI and report evidence.',
    workspacePath: '/tmp/workspace',
    schedule: { kind: 'weekdays', timezone: 'Asia/Shanghai', hour: 9, minute: 0 },
    grant: {
      preset: 'observe',
      workspacePath: '/tmp/workspace',
      allowedCapabilityIds: [],
      askCapabilityIds: [],
      blockedCapabilityIds: [],
      confirmedAt: '2026-08-04T00:00:00.000Z',
      version: 1,
    },
    notifications: { needsAttention: 'system_and_badge', failed: true, succeeded: false },
    budget: { timeoutMs: 3_600_000 },
    missedRunPolicy: 'run_latest',
    overlapPolicy: 'skip',
    status: 'active',
    ...overrides,
  };
}

function runInput(definition, overrides = {}) {
  return {
    automationId: definition.automationId,
    idempotencyKey: `${definition.automationId}:2026-08-05T01:00:00.000Z`,
    triggerSource: 'scheduled',
    status: 'scheduled',
    scheduledAt: '2026-08-05T01:00:00.000Z',
    snapshot: {
      definitionVersion: definition.version,
      name: definition.name,
      prompt: definition.prompt,
      workspacePath: definition.workspacePath,
      schedule: definition.schedule,
      grant: definition.grant,
      budget: definition.budget,
    },
    ...overrides,
  };
}

test('persists definitions and enforces optimistic versions', () => {
  const definition = store.createDefinition(definitionInput(), {
    automationId: 'automation-1',
    now: '2026-08-04T00:00:00.000Z',
  });
  assert.equal(definition.version, 1);
  assert.equal(store.getDefinition('automation-1').name, 'Daily CI review');

  const updated = store.updateDefinition('automation-1', 1, { name: 'CI health' }, {
    now: '2026-08-04T01:00:00.000Z',
  });
  assert.equal(updated.version, 2);
  assert.equal(updated.name, 'CI health');
  assert.throws(() => store.updateDefinition('automation-1', 1, { name: 'stale' }), /version_conflict/);

  const reopened = createAutomationStore({ storeDir: root });
  assert.equal(reopened.getDefinition('automation-1').version, 2);
});

test('creates immutable run snapshots and rejects duplicate idempotency keys', () => {
  const definition = store.createDefinition(definitionInput(), {
    automationId: 'automation-1',
    now: '2026-08-04T00:00:00.000Z',
  });
  const run = store.createRun(runInput(definition), {
    runId: 'run-1',
    now: '2026-08-05T01:00:01.000Z',
  });
  store.updateDefinition('automation-1', 1, { prompt: 'Changed prompt' }, {
    now: '2026-08-04T02:00:00.000Z',
  });
  assert.equal(store.getRun('run-1').snapshot.prompt, 'Inspect failed CI and report evidence.');
  assert.throws(() => store.createRun(runInput(definition), { runId: 'run-2' }), /idempotency_conflict/);
  assert.equal(run.attentionVersion, 0);
});

test('isolates corrupt run records and persists runtime state', () => {
  const definition = store.createDefinition(definitionInput(), { automationId: 'automation-1' });
  store.createRun(runInput(definition), { runId: 'run-1' });
  writeFileSync(path.join(root, 'runs', 'broken.json'), '{bad', 'utf8');
  assert.deepEqual(store.listRuns({ automationId: 'automation-1' }).map((run) => run.runId), ['run-1']);

  store.setRuntimeState({ globallyPaused: true, pausedAt: '2026-08-04T03:00:00.000Z', activeRunIds: ['run-1', 'run-1'] }, {
    now: '2026-08-04T03:00:00.000Z',
  });
  const reopened = createAutomationStore({ storeDir: root });
  assert.deepEqual(reopened.getRuntimeState(), {
    globallyPaused: true,
    pausedAt: '2026-08-04T03:00:00.000Z',
    activeRunIds: ['run-1'],
    updatedAt: '2026-08-04T03:00:00.000Z',
  });
  assert.match(readFileSync(path.join(root, 'runtime.json'), 'utf8'), /"schemaVersion": 1/);
});

test('emits structured change events without exposing mutable store state', () => {
  const events = [];
  store.setOnChange((event) => events.push(event));
  const definition = store.createDefinition(definitionInput(), { automationId: 'automation-1' });
  const run = store.createRun(runInput(definition), { runId: 'run-1' });
  store.updateRun(run.runId, { status: 'running', startedAt: '2026-08-05T01:00:02.000Z' });
  assert.deepEqual(events.map((event) => event.type), ['definition_changed', 'run_changed', 'run_changed']);
});
