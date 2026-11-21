import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAutomationStore } from './automation-store.mjs';
import { createAutomationApplicationService } from './automation-application-service.mjs';

let root;
let store;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'peer-automation-application-'));
  store = createAutomationStore({ storeDir: root });
  store.createDefinition({
    name: 'Daily', prompt: 'Inspect CI', workspacePath: '/tmp/workspace',
    schedule: { kind: 'daily', timezone: 'UTC', hour: 9, minute: 0 },
    grant: {
      preset: 'observe', workspacePath: '/tmp/workspace',
      allowedCapabilityIds: [], askCapabilityIds: [], blockedCapabilityIds: [],
      confirmedAt: '2026-08-06T00:00:00.000Z', version: 1,
    },
    notifications: { needsAttention: 'system_and_badge', failed: true, succeeded: false },
    budget: { timeoutMs: 60_000 }, missedRunPolicy: 'run_latest', overlapPolicy: 'skip', status: 'active',
  }, { automationId: 'automation-1', now: '2026-08-06T00:00:00.000Z' });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test('manual run records a visible failure when the runner is unavailable', async () => {
  const service = createAutomationApplicationService({
    store,
    getRunner: () => null,
    now: () => '2026-08-06T00:01:00.000Z',
    logger: { error() {} },
  });
  const run = await service.runNow({ automationId: 'automation-1' });
  assert.equal(run.status, 'failed');
  assert.equal(run.failureReason, 'automation_runner_unavailable');
  assert.equal(run.receipt.error, 'Automation runner is unavailable.');
});

test('manual run records an asynchronous runner startup failure', async () => {
  const service = createAutomationApplicationService({
    store,
    getRunner: () => ({ run: async () => { throw new Error('runner exploded'); } }),
    now: () => '2026-08-06T00:02:00.000Z',
    logger: { error() {} },
  });
  const created = await service.runNow({ automationId: 'automation-1' });
  assert.equal(created.status, 'scheduled');
  await new Promise((resolve) => setImmediate(resolve));
  const run = store.getRun(created.runId);
  assert.equal(run.status, 'failed');
  assert.equal(run.failureReason, 'runner exploded');
  assert.equal(run.receipt.error, 'runner exploded');
});

test('cancelRun aborts the live runner stream and marks the run cancelled', async () => {
  const cancelledIds = [];
  store.createRun({
    automationId: 'automation-1',
    idempotencyKey: 'automation-1:manual:run-active',
    triggerSource: 'manual',
    status: 'running',
    scheduledAt: '2026-08-06T00:00:00.000Z',
    snapshot: {
      definitionVersion: 1,
      name: 'Daily',
      prompt: 'Inspect CI',
      workspacePath: '/tmp/workspace',
      schedule: { kind: 'daily', timezone: 'UTC', hour: 9, minute: 0 },
      grant: {
        preset: 'observe',
        workspacePath: '/tmp/workspace',
        allowedCapabilityIds: [],
        askCapabilityIds: [],
        blockedCapabilityIds: [],
        confirmedAt: '2026-08-06T00:00:00.000Z',
        version: 1,
      },
      budget: { timeoutMs: 60_000 },
    },
  }, { runId: 'run-active', now: '2026-08-06T00:00:00.000Z' });

  const service = createAutomationApplicationService({
    store,
    getRunner: () => ({
      cancel: async (runId) => {
        cancelledIds.push(runId);
        return { aborted: true };
      },
    }),
    now: () => '2026-08-06T00:03:00.000Z',
  });
  const cancelled = service.cancelRun({ runId: 'run-active' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.failureReason, 'cancelled_by_user');
  assert.deepEqual(cancelledIds, ['run-active']);
});
