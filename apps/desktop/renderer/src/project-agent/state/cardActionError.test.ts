import assert from 'node:assert/strict';
import test from 'node:test';
import { cardActionErrorKey } from './cardActionError.ts';

test('stale task actions explain state changes without exposing backend codes', () => {
  for (const code of ['session_not_completed', 'stale_completion_review', 'not_confirmable']) assert.equal(cardActionErrorKey(code), 'projectAgent.chat.resultChanged');
  assert.equal(cardActionErrorKey('raw-provider-json'), 'projectAgent.chat.actionFailed');
});

test('recovery refusal explains the required next step without raw error codes', () => {
  assert.equal(cardActionErrorKey('EXECUTION_OUTCOME_UNKNOWN'), 'projectAgent.chat.recoveryUnknownOutcome');
  assert.equal(cardActionErrorKey('STALE_TURN'), 'projectAgent.chat.recoveryStale');
  assert.equal(cardActionErrorKey('NO_CONTINUATION_CHECKPOINT'), 'projectAgent.chat.recoveryMissingCheckpoint');
  assert.equal(cardActionErrorKey('RECOVERY_CHECKPOINT_UNAVAILABLE'), 'projectAgent.chat.recoveryMissingCheckpoint');
  assert.equal(cardActionErrorKey('WORK_BUDGET_LIMITED'), 'projectAgent.chat.budgetExhausted');
});
