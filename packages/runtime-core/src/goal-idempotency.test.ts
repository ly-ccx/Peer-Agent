import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildGoalIdempotencyKey,
  classifyGoalToolMutation,
  createGoalIdempotencyLedger,
  decideGoalToolReplay,
} from './goal-idempotency.ts';
import {
  createDurableGoalIdempotencyLedger,
  resolveGoalIdempotencyLedgerPath,
} from './goal-idempotency-durable.ts';

test('buildGoalIdempotencyKey is stable for same semantic inputs', () => {
  const a = buildGoalIdempotencyKey({
    planId: 'plan-1',
    runId: 'run-1',
    taskId: 'task-a',
    toolName: 'write_file',
    args: { path: 'a.txt', content: 'hello' },
  });
  const b = buildGoalIdempotencyKey({
    planId: 'plan-1',
    runId: 'run-1',
    taskId: 'task-a',
    toolName: 'write_file',
    args: { content: 'hello', path: 'a.txt' },
  });
  assert.equal(a, b);
  assert.equal(a.length, 64);
});

test('classifyGoalToolMutation distinguishes read / idempotent / non-idempotent', () => {
  assert.equal(classifyGoalToolMutation('read_file'), 'read_only');
  assert.equal(classifyGoalToolMutation('write_file'), 'idempotent_write');
  assert.equal(classifyGoalToolMutation('edit_file'), 'non_idempotent_write');
  assert.equal(classifyGoalToolMutation('bash', { command: 'rg -n foo src' }), 'read_only');
  assert.equal(classifyGoalToolMutation('bash', { command: 'rm -rf dist' }), 'non_idempotent_write');
});

test('decideGoalToolReplay reuses completed ledger hits', () => {
  const key = buildGoalIdempotencyKey({
    planId: 'plan-1',
    runId: 'run-1',
    taskId: 'task-a',
    toolName: 'write_file',
    args: { path: 'a.txt', content: 'x' },
  });
  const ledger = createGoalIdempotencyLedger();
  ledger.remember({
    idempotencyKey: key,
    status: 'completed',
    evidenceRefs: ['tool-result://done-1'],
    toolCallId: 'call-1',
    toolName: 'write_file',
  });

  const decision = decideGoalToolReplay({
    planId: 'plan-1',
    runId: 'run-1',
    taskId: 'task-a',
    toolName: 'write_file',
    args: { path: 'a.txt', content: 'x' },
    completedLedger: ledger.snapshot(),
  });
  assert.equal(decision.action, 'reuse');
  assert.deepEqual(decision.evidenceRefs, ['tool-result://done-1']);
});

test('decideGoalToolReplay blocks non-idempotent running tools', () => {
  const decision = decideGoalToolReplay({
    planId: 'plan-1',
    runId: 'run-1',
    taskId: 'task-a',
    toolName: 'edit_file',
    args: { path: 'a.txt', old_string: 'a', new_string: 'b' },
    openToolCalls: [{
      toolCallId: 'call-running',
      toolName: 'edit_file',
      status: 'running',
      idempotencyKey: buildGoalIdempotencyKey({
        planId: 'plan-1',
        runId: 'run-1',
        taskId: 'task-a',
        toolName: 'edit_file',
        args: { path: 'a.txt', old_string: 'a', new_string: 'b' },
      }),
    }],
  });
  assert.equal(decision.action, 'query_status');
  assert.equal(decision.reason, 'tool_still_running');
});

test('decideGoalToolReplay allows fresh read_only execute', () => {
  const decision = decideGoalToolReplay({
    planId: 'plan-1',
    runId: 'run-1',
    toolName: 'read_file',
    args: { path: 'a.txt' },
  });
  assert.equal(decision.action, 'execute');
  assert.equal(decision.mutationClass, 'read_only');
});

test('decideGoalToolReplay lets a fresh unknown command reach the permission layer', () => {
  const decision = decideGoalToolReplay({
    planId: 'plan-1',
    runId: 'run-1',
    taskId: 'task-a',
    toolName: 'bash',
    args: { command: 'pnpm --dir apps/desktop ipc:check' },
  });

  assert.equal(decision.action, 'execute');
  assert.equal(decision.reason, 'no_prior_attempt');
  assert.equal(decision.mutationClass, 'unknown');
  assert.equal(decision.matchedCall, null);
});

test('decideGoalToolReplay does not treat a different command using the same tool as a replay', () => {
  const priorKey = buildGoalIdempotencyKey({
    planId: 'plan-1',
    runId: 'run-1',
    taskId: 'task-a',
    toolName: 'bash',
    args: { command: 'pnpm ipc:check' },
  });
  const decision = decideGoalToolReplay({
    planId: 'plan-1',
    runId: 'run-1',
    taskId: 'task-a',
    toolName: 'bash',
    args: { command: 'pnpm typecheck' },
    openToolCalls: [{
      toolCallId: 'call-other-command',
      toolName: 'bash',
      status: 'running',
      idempotencyKey: priorKey,
    }],
  });

  assert.equal(decision.action, 'execute');
  assert.equal(decision.reason, 'no_prior_attempt');
  assert.equal(decision.matchedCall, null);
});

test('decideGoalToolReplay still blocks an exact unsettled unknown replay', () => {
  const args = { command: 'pnpm --dir apps/desktop ipc:check' };
  const idempotencyKey = buildGoalIdempotencyKey({
    planId: 'plan-1',
    runId: 'run-1',
    taskId: 'task-a',
    toolName: 'bash',
    args,
  });
  const decision = decideGoalToolReplay({
    planId: 'plan-1',
    runId: 'run-1',
    taskId: 'task-a',
    toolName: 'bash',
    args,
    openToolCalls: [{
      toolCallId: 'call-exact-replay',
      toolName: 'bash',
      status: 'running',
      idempotencyKey,
    }],
  });

  assert.equal(decision.action, 'block');
  assert.equal(decision.reason, 'tool_still_running');
  assert.equal(decision.mutationClass, 'unknown');
  assert.equal(decision.matchedCall?.toolCallId, 'call-exact-replay');
});

test('createDurableGoalIdempotencyLedger survives process-local reload from disk', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'goal-idempotency-'));
  try {
    const planId = 'plan-durable-1';
    const runId = 'run-durable-1';
    const key = buildGoalIdempotencyKey({
      planId,
      runId,
      taskId: 'task-a',
      toolName: 'write_file',
      args: { path: 'out.txt', content: 'once' },
    });

    const first = createDurableGoalIdempotencyLedger({
      storeDir: dir,
      planId,
      runId,
    });
    first.remember({
      idempotencyKey: key,
      status: 'completed',
      evidenceRefs: ['tool-result://persisted-1'],
      toolCallId: 'call-durable-1',
      toolName: 'write_file',
      planId,
      runId,
    });

    const expectedPath = resolveGoalIdempotencyLedgerPath({ storeDir: dir, planId, runId });
    assert.equal(first.filePath, expectedPath);
    const onDisk = JSON.parse(readFileSync(expectedPath, 'utf8'));
    assert.equal(onDisk.planId, planId);
    assert.equal(onDisk.runId, runId);
    assert.equal(onDisk.entries[key].status, 'completed');

    // Simulate process restart: new ledger instance, same storeDir/plan/run.
    const reloaded = createDurableGoalIdempotencyLedger({
      storeDir: dir,
      planId,
      runId,
    });
    const hit = reloaded.get(key);
    assert.ok(hit);
    assert.equal(hit.status, 'completed');
    assert.deepEqual(hit.evidenceRefs, ['tool-result://persisted-1']);

    const decision = decideGoalToolReplay({
      planId,
      runId,
      taskId: 'task-a',
      toolName: 'write_file',
      args: { path: 'out.txt', content: 'once' },
      completedLedger: reloaded.snapshot(),
    });
    assert.equal(decision.action, 'reuse');
    assert.equal(decision.reason, 'idempotency_ledger_hit');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
