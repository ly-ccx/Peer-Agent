import assert from 'node:assert/strict';
import test from 'node:test';
import { cardActionErrorKey } from './cardActionError.ts';

test('stale task actions explain state changes without exposing backend codes', () => {
  for (const code of ['session_not_completed', 'stale_completion_review', 'not_confirmable']) assert.equal(cardActionErrorKey(code), 'projectAgent.chat.resultChanged');
  assert.equal(cardActionErrorKey('raw-provider-json'), 'projectAgent.chat.actionFailed');
});
