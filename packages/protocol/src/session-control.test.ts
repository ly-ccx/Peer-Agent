import test from 'node:test';
import assert from 'node:assert/strict';
import { controlPhasesForOrigin, normalizeExecutionResourceScope, type SessionControlOperation } from './session-control.ts';

const operation: SessionControlOperation = {
  operationId: 'cancel', requestDigest: 'digest', revision: 3, kind: 'cancel', authorityRef: 'input',
  workspaceId: 'workspace', parentConversationId: 'parent', sessionId: 'session', planId: 'plan',
  expectedExecution: { planId: 'plan', sessionId: 'session', executionEpoch: 'epoch' },
  phase: 'settled', outcome: 'applied', updatedAt: '2026-11-01T00:00:00.000Z',
  stopReceipt: { receiptId: 'stop', operationId: 'cancel', execution: { planId: 'plan', sessionId: 'session', executionEpoch: 'epoch' },
    admissionClosed: true, runnerIdle: true, schedulerIdle: true, resourceClaims: [], unknownCalls: [], scope: 'managed_execution', completedAt: '2026-11-01T00:00:00.000Z' },
};

test('canonical stop completion suppresses the stale takeover mirror on every product projection', () => {
  const facts = controlPhasesForOrigin({ executionControl: operation, cancellation: { phase: 'stopping' }, takeover: { phase: 'stopping' } });
  assert.equal(facts.cancellationPhase, 'completed');
  assert.equal(facts.takeoverPhase, undefined);
});

test('a refused reconciling stop is awaiting outcome, while a drain still in progress stays stopping', () => {
  const refused = controlPhasesForOrigin({ executionControl: { ...operation, phase: 'reconciling', outcome: undefined, stopReceipt: undefined, nextAction: 'execution_stop_unconfirmed' }, cancellation: { phase: 'stopping' } });
  assert.equal(refused.cancellationPhase, 'awaiting_outcome');
  const draining = controlPhasesForOrigin({ executionControl: { ...operation, phase: 'draining', outcome: undefined, stopReceipt: undefined }, cancellation: { phase: 'stopping' } });
  assert.equal(draining.cancellationPhase, 'stopping');
});

test('an incomplete canonical stop cannot inherit success from a stale cancellation mirror', () => {
  const facts = controlPhasesForOrigin({ executionControl: { ...operation, phase: 'draining', outcome: undefined, stopReceipt: undefined }, cancellation: { phase: 'completed' } });
  assert.equal(facts.cancellationPhase, 'stopping');
});

test('resource scopes keep their discriminated shape and reject unknown or padded variants', () => {
  assert.deepEqual(normalizeExecutionResourceScope({ kind: 'directory', path: '/repo' }), { kind: 'directory', path: '/repo' });
  assert.deepEqual(normalizeExecutionResourceScope({ kind: 'file', path: '/repo/a.ts' }), { kind: 'file', path: '/repo/a.ts' });
  assert.deepEqual(normalizeExecutionResourceScope({ kind: 'git_ref', ref: 'refs/heads/main' }), { kind: 'git_ref', ref: 'refs/heads/main' });
  assert.deepEqual(normalizeExecutionResourceScope({ kind: 'remote_object', ref: 'pr:123' }), { kind: 'remote_object', ref: 'pr:123' });
  assert.equal(normalizeExecutionResourceScope({ kind: 'auto', path: '/repo' }), undefined);
  assert.equal(normalizeExecutionResourceScope({ kind: 'directory', path: '/repo', extra: 1 }), undefined);
  assert.equal(normalizeExecutionResourceScope({ kind: 'git_ref', ref: '../etc/passwd' }), undefined);
  assert.equal(normalizeExecutionResourceScope('directory:/repo'), undefined);
});
