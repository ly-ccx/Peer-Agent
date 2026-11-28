import test from 'node:test';
import assert from 'node:assert/strict';
import { createI18n } from '@peer-agent/i18n';
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
  assert.equal(userReceipt({ ...base, pending: 'received' }, true).labelKey, 'projectAgent.chat.replied');
  assert.equal(userReceipt({ ...base, pending: 'failed' }, true).retryInputId, 'u');
  assert.equal(userReceipt({ ...base, pending: 'failed' }, true).labelKey, 'projectAgent.chat.failed');
  assert.equal(userReceipt({ inputId: 'u', dispositions: [] }, false).labelKey, 'projectAgent.chat.received');
  assert.equal(userReceipt({ dispositions: [] }, false).labelKey, null);
});

test('unknown delivery is neither received nor a definitive failure and retains retry, restore and confirmed discard actions', () => {
  const receipt = userReceipt({ inputId: 'same-id', pending: 'unknown', dispositions: [] }, false);
  assert.equal(receipt.labelKey, 'projectAgent.chat.inputUnconfirmed');
  assert.equal(receipt.retryInputId, 'same-id');
  assert.equal(receipt.restoreInputId, 'same-id');
  assert.equal(receipt.discardInputId, 'same-id');
  assert.equal(receipt.requiresDiscardConfirm, true);
});

test('definitive rejection hides retry, maps specific causes, and only disables restore when the target is unavailable', () => {
  const closed = userReceipt({ inputId: 'q1', pending: 'rejected', rejectionCode: 'QUESTION_CLOSED', dispositions: [] }, false);
  assert.equal(closed.labelKey, 'projectAgent.chat.inputRejectedQuestionClosed');
  assert.equal(closed.retryInputId, undefined);
  assert.equal(closed.restoreInputId, 'q1');
  assert.equal(closed.discardInputId, 'q1');
  assert.equal(closed.requiresDiscardConfirm, false);

  const resource = userReceipt({ inputId: 'r1', pending: 'rejected', rejectionCode: 'RESOURCE_FEEDBACK_RECIPIENT_CHANGED', dispositions: [] }, false);
  assert.equal(resource.labelKey, 'projectAgent.chat.inputRejectedResourceFeedback');
  assert.equal(resource.restoreInputId, 'r1');

  const missing = userReceipt({ inputId: 'm1', pending: 'rejected', rejectionCode: 'NOT_FOUND', dispositions: [] }, false);
  assert.equal(missing.labelKey, 'projectAgent.chat.inputRejectedTargetUnavailable');
  assert.equal(missing.retryInputId, undefined);
  assert.equal(missing.restoreInputId, undefined);
  assert.equal(missing.discardInputId, 'm1');
  assert.equal(missing.requiresDiscardConfirm, false);

  const invalid = userReceipt({ inputId: 'i1', pending: 'rejected', rejectionCode: 'INVALID_INPUT', dispositions: [] }, false);
  assert.equal(invalid.labelKey, 'projectAgent.chat.inputRejected');
  assert.equal(invalid.restoreInputId, 'i1');
});

test('waiting receipt has localized copy without implying queued execution', () => {
  const base = { inputId: 'u', dispositions: [] };
  const receipt = userReceipt(base, false, 'waiting');
  assert.ok(receipt.labelKey);
  assert.equal(createI18n('zh-CN').t(receipt.labelKey), '已收到 · 等待处理');
  assert.equal(createI18n('en-US').t(receipt.labelKey), 'Received · waiting');
  assert.equal(receipt.retryInputId, undefined);
  assert.equal(userReceipt(base, false, 'deliveryIssue').labelKey, 'projectAgent.chat.reply.deliveryIssue');
  assert.equal(userReceipt({ ...base, pending: 'unknown' }, false, 'waiting').retryInputId, 'u');
});
