import test from 'node:test';
import assert from 'node:assert/strict';
import { reduceSessionControl, controlDigest } from './session-control-kernel.mjs';

function operation(operationId, kind = 'takeover') {
  const authorityRef = 'input:actual-user', expectedExecution = { planId: 'plan', sessionId: 'session', executionEpoch: 'epoch' };
  return { operationId, kind, authorityRef, workspaceId: 'workspace', parentConversationId: 'parent', sessionId: 'session', planId: 'plan', expectedExecution,
    requestDigest: controlDigest({ kind, operationId, authorityRef, execution: expectedExecution }), phase: 'recorded', revision: 1, updatedAt: '2026-11-01T00:00:00.000Z' };
}
const commit = (state, value, expectedCurrentOperationId = null) => reduceSessionControl(state,
  { operation: value, expectedRevision: value.revision - 1, expectedCurrentOperationId });

test('cancel durably supersedes an in-flight takeover without inventing a stop receipt', () => {
  const a = operation('takeover'), b = operation('cancel', 'cancel');
  const state = commit(commit({}, a), b, a.operationId);
  assert.equal(state.sessionControls.takeover.outcome, 'superseded');
  assert.equal(state.sessionControls.takeover.supersededBy, b.operationId);
  assert.equal(state.sessionControls.takeover.stopReceipt, undefined);
  assert.equal(state.sessionControlHeads.session.operationId, b.operationId);
  assert.throws(() => commit(state, { ...a, revision: 2, phase: 'draining' }), /conflict|superseded/);
});

test('an unclosed cancellation cannot be displaced by a new takeover', () => {
  const state = commit({}, operation('cancel', 'cancel'));
  assert.throws(() => commit(state, operation('takeover'), 'cancel'), /work_execution_stopped/);
});

test('control application requires a receipt bound to the exact stopped execution', () => {
  const a = operation('cancel', 'cancel'), state = commit({}, a);
  assert.throws(() => commit(state, { ...a, revision: 2, phase: 'settled', outcome: 'applied' }), /receipt_required/);
  const stopReceipt = { operationId: a.operationId, execution: { ...a.expectedExecution, executionEpoch: 'another-epoch' },
    admissionClosed: true, runnerIdle: true, schedulerIdle: true, unknownCalls: [], scope: 'managed_execution' };
  assert.throws(() => commit(state, { ...a, revision: 2, phase: 'settled', outcome: 'applied', stopReceipt }), /receipt_invalid/);
});

test('request revisions, parameters and scope are immutable across replay', () => {
  const a = operation('takeover'), state = commit({}, a);
  assert.throws(() => commit(state, { ...a, revision: 2, phase: 'draining', workspaceId: 'unrelated' }), /conflict/);
  assert.throws(() => commit(state, { ...a, revision: 2, phase: 'draining', requestDigest: 'changed' }), /conflict/);
  assert.throws(() => commit(state, { ...a, revision: 3, phase: 'draining' }), /conflict/);
});
