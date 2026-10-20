import test from 'node:test';
import assert from 'node:assert/strict';
import { userReceipt } from './userReceiptState.ts';
import type { BotDispositionMark } from './botConversationState.ts';

const answered = (sessionIds: string[]): BotDispositionMark => ({ kind: 'answered', sessionIds, labelKey: 'projectAgent.chat.disposition.answered' });
test('one reply with three task sources produces one input receipt, with no duplicate task buttons', () => {
  const receipt = userReceipt({ inputId: 'u', dispositions: [answered(['a', 'b', 'c'])] }, true);
  assert.equal(receipt.labelKey, 'projectAgent.chat.replied');
  assert.deepEqual(receipt.taskMarks, []);
  assert.deepEqual(userReceipt({ dispositions: [answered(['a']), answered(['b']), answered(['c'])] }, false), receipt);
});
test('reply acknowledgement preserves distinct task actions and never implies task completion', () => {
  const stopped: BotDispositionMark = { kind: 'stopped', sessionIds: ['a'], labelKey: 'projectAgent.chat.disposition.stopped' };
  const marks = [stopped, answered(['a', 'b'])];
  assert.deepEqual(userReceipt({ dispositions: marks }, true).taskMarks, [stopped]);
  assert.equal(marks.length, 2, 'canonical facts remain intact');
  assert.equal(userReceipt({ dispositions: [stopped] }, false).labelKey, null);
});
test('pending delivery and failure take precedence over historical replies, and retry retains input identity', () => {
  const base = { inputId: 'u', dispositions: [answered(['old'])] };
  assert.equal(userReceipt({ ...base, pending: 'sending' }, true).labelKey, 'projectAgent.chat.sending');
  assert.equal(userReceipt({ ...base, pending: 'received' }, true).labelKey, 'projectAgent.chat.received');
  assert.equal(userReceipt({ ...base, pending: 'failed' }, true).retryInputId, 'u');
  assert.equal(userReceipt({ ...base, pending: 'failed' }, true).labelKey, 'projectAgent.chat.failed');
  assert.equal(userReceipt({ inputId: 'u', dispositions: [] }, false).labelKey, 'projectAgent.chat.received');
  assert.equal(userReceipt({ dispositions: [] }, false).labelKey, null);
});
