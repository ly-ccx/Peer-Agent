import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectAgentActivity } from '@peer-agent/protocol';
import { normalizeBotMessage, type ConversationDisplayRow } from './botConversationState.ts';
import { continuousReplyRows, replyRowContains, replyRowMood, replyRowRunning, type BotReplyRow } from './botReplyContinuity.ts';
const at = '2026-10-22T00:00:00Z';
function message(id: string, kind: string, extra: Record<string, unknown> = {}) {
  return normalizeBotMessage({ id, kind, role: kind === 'user_input' ? 'user' : 'assistant', createdAt: at, ...extra })!;
}
const user = message('input-u', 'user_input', { inputId: 'u' });
const row = (message: ReturnType<typeof normalizeBotMessage>): ConversationDisplayRow => ({ type: 'message', message: message! });
function activity(extra: Partial<ProjectAgentActivity> = {}): ProjectAgentActivity {
  return { workspaceId: 'w', conversationId: 'c', turnId: 'turn', workId: 'work', startedAt: at, revision: 1,
    phase: 'thinking', replyTo: [user.id], segments: [], replyText: '', ...extra };
}
const replies = (rows: ReturnType<typeof continuousReplyRows>) => rows.filter((r): r is BotReplyRow => r.type === 'reply');
test('pending, public stream and final retain one carrier and original anchors', () => {
  const cache = new Map<string, string>();
  const waiting = replies(continuousReplyRows([row(user)], [user], [{ inputId: 'u', createdAt: at }], [], cache))[0]!;
  const live = activity({ segments: [{ kind: 'text', id: 'opening', text: '先核对事实。' }] });
  const streaming = replies(continuousReplyRows([row(user), { type: 'activity', activity: live }], [user], [], [], cache))[0]!;
  const turn = message('turn', 'agent_turn', { replyTo: [user.id], meta: { workId: 'work' }, publicUpdates: [{ id: 'opening', text: '先核对事实。' }] });
  const final = message('final', 'agent_reply', { turnId: 'turn', replyTo: [user.id], content: '已完成。' });
  const finished = replies(continuousReplyRows([row(user), row(turn), row(final)], [user, turn, final], [], [], cache))[0]!;
  assert.equal(waiting.id, streaming.id); assert.equal(streaming.id, finished.id);
  assert.equal(streaming.paragraphs[0]!.id, finished.paragraphs[0]!.id);
  assert.deepEqual(finished.paragraphs.map(p => p.text), ['先核对事实。', '已完成。']);
  assert.ok(replyRowContains(finished, 'turn')); assert.ok(replyRowContains(finished, 'final'));
  assert.equal(replyRowRunning(finished), false); assert.equal(replyRowMood(finished), 'idle');
});
test('restored unanswered input is unconfirmed rather than invented running work', () => {
  const restored = replies(continuousReplyRows([row(user)], [user], [], []))[0]!;
  assert.equal(restored.pending?.restored, true); assert.equal(replyRowRunning(restored), false);
});
test('another input answer cannot clear this input wait', () => {
  const other = message('input-v', 'user_input', { inputId: 'v' });
  const final = message('reply-v', 'agent_reply', { replyTo: [other.id], content: '答复 v' });
  const result = replies(continuousReplyRows([row(user), row(other), row(final)], [user, other, final], [{ inputId: 'u', createdAt: at }], []));
  assert.ok(result.some(r => r.pending && r.replyTo.includes(user.id)));
  assert.ok(result.some(r => r.message?.id === final.id));
});
test('yielded attempts share public paragraphs while canonical later replies stay separate', () => {
  const first = message('first', 'agent_turn', { replyTo: [user.id], meta: { workId: 'work' }, publicUpdates: [{ id: 'a', text: '第一步' }] });
  const next = activity({ turnId: 'next', segments: [{ kind: 'text', id: 'b', text: '第二步' }] });
  const result = replies(continuousReplyRows([row(user), row(first), { type: 'activity', activity: next }], [user, first], [], []));
  assert.equal(result.length, 1); assert.deepEqual(result[0]!.paragraphs.map(p => p.text), ['第一步', '第二步']);
  const final = message('final', 'agent_reply', { turnId: 'first', replyTo: [user.id], content: '结论一' });
  const later = message('later', 'agent_reply', { turnId: 'first', replyTo: [user.id], content: '补充结论' });
  assert.equal(replies(continuousReplyRows([row(first), row(final), row(later)], [user, first, final, later], [], [])).length, 2);
});
test('canonical reuse of a public paragraph retains its node without duplicating text', () => {
  const turn = message('turn', 'agent_turn', { replyTo: [user.id], publicUpdates: [{ id: 'a', text: '已完成。' }] });
  const final = message('final', 'agent_reply', { turnId: 'turn', replyTo: [user.id], content: '已完成。' });
  const result = replies(continuousReplyRows([row(turn), row(final)], [user, turn, final], [], []))[0]!;
  assert.deepEqual(result.paragraphs, [{ id: 'turn:a', text: '已完成。' }]);
});
test('delivery uncertainty keeps receipt without declaring active execution', () => {
  const result = replies(continuousReplyRows([row(user)], [user], [{ inputId: 'u', createdAt: at, deliveryIssue: true }], []))[0]!;
  assert.equal(replyRowRunning(result), false); assert.equal(replyRowMood(result), 'error');
});
test('a later active attempt retires the old failure display but preserves its detail record', () => {
  const failed = message('failed', 'system_card', { turnId: 'old', replyTo: [user.id], cards: [{ cardId: 'failure', kind: 'agent_unavailable', title: '失败', body: '' }] });
  const before = JSON.stringify(failed);
  const result = replies(continuousReplyRows([row(failed), { type: 'activity', activity: activity() }], [user, failed], [], []))[0]!;
  assert.equal(result.message, undefined); assert.ok(result.messages.includes(failed)); assert.equal(JSON.stringify(failed), before);
  assert.equal(replyRowRunning(result), true);
});


test('an unknown local input has no invented reply or active execution placeholder', () => {
  const unknown = { ...user, pending: 'unknown' as const };
  const pending = [{ inputId: 'u', text: 'pending', quoteRefs: [], attachments: [], createdAt: at, state: 'unknown' as const }];
  const result = continuousReplyRows([row(unknown)], [unknown], [{ inputId: 'u', createdAt: at }], pending);
  assert.equal(replies(result).length, 0);
});
