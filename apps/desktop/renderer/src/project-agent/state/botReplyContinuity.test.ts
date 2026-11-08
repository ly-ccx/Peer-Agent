import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectAgentActivity } from '@peer-agent/protocol';
import { conversationRows, normalizeBotMessage, type BotChatMessage, type ConversationDisplayRow } from './botConversationState.ts';
import { attachBotProcesses, visibleBotActivity } from './botActivityState.ts';
import { awaitingInputAnswered, continuousReplyRows, conversationRowShowsAuthor, replyRowContains, replyRowMood, replyRowRunning, type BotReplyRow } from './botReplyContinuity.ts';
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

const received = [{ inputId: 'u', text: '你不知道 rc 40 是哪个分支打的包吗？', quoteRefs: [], attachments: [], createdAt: at, state: 'received' as const }];
const awaiting = [{ inputId: 'u', createdAt: at }];
function live(extra: Partial<ProjectAgentActivity> = {}): ProjectAgentActivity {
  return activity({ phase: 'waiting', replyText: '', segments: [], ...extra });
}
function project(messages: BotChatMessage[], current: ProjectAgentActivity | null, cache = new Map<string, string>()) {
  const rows = attachBotProcesses(conversationRows(messages), messages, current);
  const visible = current ? visibleBotActivity(current, messages) : null;
  if (visible) rows.push({ type: 'activity', activity: visible });
  return continuousReplyRows(rows, messages, awaiting, received, cache);
}
const authors = (rows: ReturnType<typeof project>) => rows.filter(conversationRowShowsAuthor);

test('send, pending, first token, streaming and done stay one bot row', () => {
  const prior = message('input-old', 'user_input', { inputId: 'old' });
  const earlier = message('old-reply', 'agent_reply', { replyTo: [prior.id], content: '上一轮已经回答过。' });
  const messages = [prior, earlier, user];
  const cache = new Map<string, string>();
  const pending = project(messages, null, cache);
  const waiting = project(messages, live(), cache);
  const thinking = project(messages, live({ phase: 'thinking' }), cache);
  const tool = project(messages, live({ phase: 'tool', segments: [{ kind: 'tool', id: 'read', name: 'read_file', status: 'running', summary: 'README.md' }] }), cache);
  const first = project(messages, live({ phase: 'responding', segments: [{ kind: 'text', id: 'text-1', text: '我先核对打包记录。' }] }), cache);
  const streaming = project(messages, live({ phase: 'responding', segments: [{ kind: 'text', id: 'text-1', text: '我先核对打包记录。rc.40 来自 PeerAgent/dev/0.1.0。' }] }), cache);
  const turn = message('turn', 'agent_turn', { replyTo: [user.id], publicUpdates: [{ id: 'text-1', text: '我先核对打包记录。rc.40 来自 PeerAgent/dev/0.1.0。' }] });
  const final = message('final', 'agent_reply', { turnId: 'turn', replyTo: [user.id], content: 'rc.40 是 PeerAgent/dev/0.1.0 打出来的。' });
  const done = continuousReplyRows(
    attachBotProcesses(conversationRows([prior, earlier, user, turn, final]), [prior, earlier, user, turn, final], null),
    [prior, earlier, user, turn, final], [], [], cache);
  for (const rows of [pending, waiting, thinking, tool, first, streaming, done]) {
    const fresh = authors(rows).filter(row => row.type === 'reply' && row.replyTo.includes(user.id));
    assert.equal(fresh.length, 1, rows.map(row => row.type === 'reply' ? row.id : row.type).join(','));
  }
  const id = authors(pending).filter(row => row.type === 'reply' && row.replyTo.includes(user.id))[0];
  assert.ok(id?.type === 'reply');
  for (const rows of [waiting, thinking, tool, first, streaming, done]) {
    const same = authors(rows).find(row => row.type === 'reply' && row.replyTo.includes(user.id));
    assert.equal(same?.type === 'reply' && same.id, id.id);
  }
  assert.equal(authors(done).find(row => row.type === 'reply' && row.id === id.id)?.type === 'reply'
    && authors(done).find(row => row.type === 'reply' && row.id === id.id) && true, true);
});

test('a long model wait, tool-only work, and reasoning with no text never stack a second avatar', () => {
  const messages = [user];
  const cases = [
    live({ replyTo: [] }),
    live({ replyTo: ['u'], phase: 'tool', segments: [{ kind: 'tool', id: 'read', name: 'read_file', status: 'running' }] }),
    live({ replyTo: ['input-other'], phase: 'thinking' }),
    live({ replyTo: [user.id], phase: 'waiting' }),
  ];
  for (const current of cases) {
    const rows = project(messages, current);
    assert.equal(authors(rows).length, 1, JSON.stringify(current.replyTo));
    assert.equal(rows.filter(row => row.type === 'reply').length, 1);
    const reply = rows.find(row => row.type === 'reply');
    assert.equal(reply?.type === 'reply' && replyRowRunning(reply), true);
  }
});

test('a user message id that is not input-${inputId} still shares the live row', () => {
  const custom = message('uuid-user', 'user_input', { inputId: 'u' });
  const rows = project([custom], live({ replyTo: [custom.id] }));
  assert.equal(authors(rows).length, 1);
  assert.equal(rows.filter(row => row.type === 'reply').length, 1);
});

test('an empty assistant body does not render a header, including beside a live reply', () => {
  const blank = message('blank', 'agent_reply', { content: '', replyTo: [] });
  assert.equal(conversationRowShowsAuthor({ type: 'message', message: blank }), false);
  const folded = replies(continuousReplyRows([row(blank)], [blank], [], []))[0]!;
  assert.equal(conversationRowShowsAuthor(folded), false);
  const rows = project([user, blank], live({ replyTo: [] }));
  assert.equal(authors(rows).length, 1);
  assert.equal(authors(rows)[0]?.type === 'reply' && replyRowRunning(authors(rows)[0]), true);
});

test('a delivered reply clears the awaited input whichever anchor spelling was stored', () => {
  const delivered = message('final', 'agent_reply', { replyTo: ['u'], content: '好' });
  assert.equal(awaitingInputAnswered([user, delivered], 'u'), true);
  assert.equal(awaitingInputAnswered([user], 'u'), false);
});
