import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createGoalPlanStore } from '../goal-plan-store.mjs';
import {
  applyStartupApprovalRecovery,
  createApprovalStore,
  digestApprovalArgs,
} from './approval-store.mjs';

function tempRoot(name) {
  return mkdtempSync(path.join(os.tmpdir(), `peer-approvals-${name}-`));
}

function openRecord(overrides = {}) {
  return {
    approvalId: 'chat-permission:tool-1',
    workspaceId: null,
    conversationId: 'c1',
    streamId: 's1',
    planId: null,
    capabilityId: 'local.shell.exec',
    summary: 'echo hello',
    riskLevel: 'L1_local_read',
    argsDigest: digestApprovalArgs({ command: 'echo hello' }),
    createdAt: '2026-09-26T00:00:00.000Z',
    state: 'open',
    ...overrides,
  };
}

test('append folds to the latest state and ignores a repeated write', () => {
  const root = tempRoot('fold');
  try {
    const store = createApprovalStore({ rootDir: root, now: () => new Date('2026-09-26T01:00:00.000Z') });
    const first = store.append(openRecord());
    const file = store.fileFor(null);
    const before = readFileSync(file, 'utf8');
    const second = store.append(openRecord());
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.equal(second.state, 'open');
    assert.equal(second.approvalId, first.approvalId);

    store.append({
      ...openRecord(),
      state: 'approved',
      decidedAt: '2026-09-26T01:00:00.000Z',
      decidedBy: 'local_ui',
    });
    const folded = store.list();
    assert.equal(folded.length, 1);
    assert.equal(folded[0].state, 'approved');
    assert.equal(folded[0].decidedBy, 'local_ui');
    assert.equal(readFileSync(file, 'utf8').includes('UNIQUE_SHOULD_NOT_APPEAR'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('redacts secrets in the summary and refuses to use workspaceId as a path escape', () => {
  const root = tempRoot('redact');
  try {
    const store = createApprovalStore({ rootDir: root });
    const stored = store.append(openRecord({
      workspaceId: '../escape',
      summary: 'curl -H "Authorization: Bearer abcdefghijklmnop" sk-abcdefghijklmnop token=supersecret',
    }));
    assert.equal(stored.workspaceId, null);
    assert.equal(stored.summary.includes('abcdefghijklmnop'), false);
    assert.equal(stored.summary.includes('supersecret'), false);
    assert.equal(stored.summary.includes('[redacted]'), true);
    const file = readFileSync(store.fileFor(null), 'utf8');
    assert.equal(file.includes('supersecret'), false);
    assert.equal(file.includes('../escape'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('splits files by workspaceId and compacts history down to open and stale rows', () => {
  const root = tempRoot('compact');
  try {
    const store = createApprovalStore({ rootDir: root, compactBytes: 120 });
    const workspaceId = '00000000-0000-4000-8000-000000000001';
    store.append(openRecord({ approvalId: 'keep-open', workspaceId }));
    for (let index = 0; index < 8; index += 1) {
      store.append(openRecord({
        approvalId: `done-${index}`,
        workspaceId,
        state: 'denied',
        decidedAt: '2026-09-26T02:00:00.000Z',
        decidedBy: 'local_ui',
      }));
    }
    const file = store.fileFor(workspaceId);
    const afterCompact = readFileSync(file, 'utf8');
    assert.equal(afterCompact.includes('keep-open'), true);
    assert.equal(afterCompact.includes('done-0'), false);
    assert.deepEqual(store.list({ workspaceId }).map((row) => row.approvalId), ['keep-open']);

    const again = store.append(openRecord({ approvalId: 'keep-open', workspaceId }));
    assert.equal(again.state, 'open');
    assert.equal(readFileSync(file, 'utf8'), afterCompact);

    store.append(openRecord({
      approvalId: 'keep-stale',
      workspaceId,
      state: 'stale',
      decidedAt: '2026-09-26T03:00:00.000Z',
    }));
    const states = store.list({ workspaceId }).map((row) => `${row.approvalId}:${row.state}`).sort();
    assert.deepEqual(states, ['keep-open:open', 'keep-stale:stale']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('startup turns open records stale and a second pass does not rewrite them', () => {
  const root = tempRoot('stale');
  try {
    const store = createApprovalStore({ rootDir: root, now: () => new Date('2026-09-26T04:00:00.000Z') });
    store.append(openRecord({ approvalId: 'open-1' }));
    store.append(openRecord({
      approvalId: 'already',
      state: 'approved',
      decidedAt: '2026-09-26T03:00:00.000Z',
      decidedBy: 'local_ui',
    }));
    const changed = store.markStaleOnStartup();
    assert.deepEqual(changed.map((row) => row.approvalId), ['open-1']);
    assert.equal(changed[0].state, 'stale');
    const file = store.fileFor(null);
    const once = readFileSync(file, 'utf8');
    const second = store.markStaleOnStartup();
    assert.deepEqual(second, []);
    assert.equal(readFileSync(file, 'utf8'), once);
    const folded = Object.fromEntries(store.list().map((row) => [row.approvalId, row.state]));
    assert.deepEqual(folded, { 'open-1': 'stale', already: 'approved' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('startup interrupts an executing GoalPlan and only marks a session that has no plan', () => {
  const root = tempRoot('goal');
  const plans = tempRoot('plans');
  try {
    const approvals = createApprovalStore({
      rootDir: root,
      now: () => new Date('2026-09-26T05:00:00.000Z'),
    });
    const goals = createGoalPlanStore({ storeDir: plans });
    const executing = goals.createPlan({
      conversationId: 'c-exec',
      title: 'Needs approval',
      goal: 'Write the file',
      status: 'executing',
      tasks: [{ taskId: 'write', title: 'Write', status: 'running' }],
    });
    goals.setRunnerState(executing.planId, {
      enabled: true,
      status: 'running',
      intent: 'execute',
      phase: 'act',
    });
    const paused = goals.createPlan({
      conversationId: 'c-paused',
      title: 'Paused',
      goal: 'Wait',
      status: 'paused',
      tasks: [{ taskId: 'wait', title: 'Wait', status: 'pending' }],
    });
    const untouched = goals.createPlan({
      conversationId: 'c-free',
      title: 'Still running',
      goal: 'Continue',
      status: 'executing',
      tasks: [{ taskId: 'go', title: 'Go', status: 'pending' }],
    });
    approvals.append(openRecord({
      approvalId: 'approval-exec',
      conversationId: 'c-exec',
      planId: executing.planId,
    }));
    approvals.append(openRecord({
      approvalId: 'approval-paused',
      conversationId: 'c-paused',
      planId: paused.planId,
    }));
    approvals.append(openRecord({
      approvalId: 'approval-plain',
      conversationId: 'c-plain',
      planId: null,
    }));

    const recovery = applyStartupApprovalRecovery({ approvalStore: approvals, goalPlanStore: goals });
    assert.deepEqual(recovery.interruptedPlanIds, [executing.planId]);
    const interrupted = goals.getPlan(executing.planId);
    assert.equal(interrupted.status, 'interrupted');
    assert.equal(interrupted.runner.interruption.reason, 'approval_interrupted');
    assert.equal(interrupted.runner.interruption.source, 'approval_interrupted');
    assert.equal(goals.getPlan(paused.planId).status, 'paused');
    assert.equal(goals.getPlan(untouched.planId).status, 'executing');
    assert.equal(approvals.list().every((row) => row.state === 'stale'), true);

    const again = applyStartupApprovalRecovery({ approvalStore: approvals, goalPlanStore: goals });
    assert.deepEqual(again.interruptedPlanIds, []);
    assert.equal(goals.getPlan(executing.planId).status, 'interrupted');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(plans, { recursive: true, force: true });
  }
});
