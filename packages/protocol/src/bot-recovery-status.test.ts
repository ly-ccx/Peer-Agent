import test from 'node:test';
import assert from 'node:assert/strict';
import { projectBotRecoveryStatus } from './bot-conversation-read.ts';
test('history conflicts and uncompleted reconciliation cannot be fixed by a read retry', () => {
  for (const code of ['coordination_legacy_changed', 'coordination_repair_incomplete', 'coordination_writer_fence_missing']) {
    assert.deepEqual(projectBotRecoveryStatus(code, 'inputs'), { state: 'blocked', reason: 'history_conflict', code, phase: 'inputs', retryable: false });
  }
  assert.equal(projectBotRecoveryStatus('coordination_reconciliation_required').reason, 'reconciliation_required');
  assert.equal(projectBotRecoveryStatus('coordination_reconciliation_required').retryable, false);
});
test('unexpected error content is not exposed as diagnostic code', () => {
  assert.equal(projectBotRecoveryStatus('/private/secret path').code, 'RECOVERY_FAILED');
  assert.equal(projectBotRecoveryStatus('lease_unavailable').retryable, true);
});
