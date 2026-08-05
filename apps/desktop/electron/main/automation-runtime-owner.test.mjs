import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAutomationStore } from './automation-store.mjs';
import { createAutomationRuntimeOwner } from './automation-runtime-owner.mjs';

let root;
let store;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'peer-automation-runtime-owner-'));
  store = createAutomationStore({ storeDir: root });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function createDefinition() {
  return store.createDefinition({
    name: 'Daily', prompt: 'Inspect CI', workspacePath: '/tmp/workspace',
    schedule: { kind: 'daily', timezone: 'UTC', hour: 9, minute: 0 },
    grant: {
      preset: 'observe', workspacePath: '/tmp/workspace',
      allowedCapabilityIds: [], askCapabilityIds: [], blockedCapabilityIds: [],
      confirmedAt: '2026-08-04T00:00:00.000Z', version: 1,
    },
    notifications: { needsAttention: 'system_and_badge', failed: true, succeeded: false },
    budget: { timeoutMs: 60_000 }, missedRunPolicy: 'run_latest', overlapPolicy: 'skip', status: 'active',
  }, { automationId: 'automation-1', now: '2026-08-04T00:00:00.000Z' });
}

test('binds resume/activity and removes listeners on dispose', () => {
  createDefinition();
  const powerMonitor = new EventEmitter();
  const timers = [];
  const cancelled = [];
  let now = Date.parse('2026-08-04T02:00:00.000Z');
  const owner = createAutomationRuntimeOwner({
    store, powerMonitor, clock: () => now,
    scheduleTimer: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; },
    cancelTimer: (timer) => cancelled.push(timer),
    logger: { warn() {}, error() {} },
  });
  owner.start();
  assert.equal(powerMonitor.listenerCount('resume'), 1);
  assert.equal(powerMonitor.listenerCount('user-did-become-active'), 1);
  powerMonitor.emit('resume');
  powerMonitor.emit('user-did-become-active');
  owner.dispose();
  assert.equal(powerMonitor.listenerCount('resume'), 0);
  assert.equal(powerMonitor.listenerCount('user-did-become-active'), 0);
  assert.ok(cancelled.length >= 1);
});

test('detects wall-clock drift through the same scheduler seam', () => {
  createDefinition();
  const timers = [];
  let now = Date.parse('2026-08-04T02:00:00.000Z');
  const owner = createAutomationRuntimeOwner({
    store, powerMonitor: new EventEmitter(), clock: () => now,
    scheduleTimer: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; },
    cancelTimer: () => {}, timeCheckIntervalMs: 60_000, driftToleranceMs: 5_000,
    logger: { warn() {}, error() {} },
  });
  owner.start();
  const driftCheck = timers.find((timer) => timer.delay === 60_000);
  assert.ok(driftCheck);
  now += 10 * 60_000;
  driftCheck.callback();
  assert.ok(timers.filter((timer) => timer.delay === 60_000).length >= 2);
  owner.dispose();
});
