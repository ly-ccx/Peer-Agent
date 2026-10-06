import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeBotMessage, repliedUserIds, type ConversationDisplayRow } from './botConversationState.ts';
import { replyAnchorsForMessages, replyReferencesForRows } from './replyReferenceState.ts';

function message(id: string, kind: string, replyTo: string[] = [], extra: Record<string, unknown> = {}): ConversationDisplayRow {
  return { type: 'message', message: normalizeBotMessage({ id, kind, role: kind === 'user_input' ? 'user' : 'assistant', replyTo, ...extra })! };
}
function activity(replyTo: string[]): ConversationDisplayRow {
  return { type: 'activity', activity: { workspaceId: 'w', conversationId: 'c', turnId: 'turn', revision: 1,
    startedAt: '2026-10-05T01:00:00Z', phase: 'responding', replyTo, segments: [], replyText: '' } };
}
const separator: ConversationDisplayRow = { type: 'separator', id: 'time', at: '2026-10-05T01:00:00Z', proactive: false, label: '' };

test('adjacent normal waiting, streaming, canonical, historical and terminal replies do not repeat the user message', () => {
  const user = message('u', 'user_input');
  for (const reply of [activity(['u']), message('r', 'agent_reply', ['u']), message('stopped', 'system_card', ['u']), message('failed', 'system_card', ['u'])]) {
    const references = replyReferencesForRows([user, separator, reply]);
    assert.deepEqual(references.get(reply), []);
    assert.deepEqual(reply.type === 'activity' ? reply.activity.replyTo : reply.type === 'message' ? reply.message.replyTo : [], ['u']);
  }
});

test('older, multi-source and unresolved paged anchors retain their navigation references', () => {
  const old = message('old', 'user_input'), current = message('current', 'user_input');
  for (const ids of [['old'], ['old', 'current'], ['not-loaded']]) {
    for (const reply of [activity(ids), message('r', 'agent_reply', ids)]) {
      assert.deepEqual(replyReferencesForRows([old, current, reply]).get(reply), ids);
    }
  }
});

test('proactive replies and explicit user-selected quotes retain context', () => {
  const user = message('u', 'user_input', [], { quoteRefs: ['prior-reply', 'selected excerpt'] });
  const proactive = message('p', 'agent_reply', ['u'], { proactive: true });
  const explicit = message('q', 'agent_reply', ['u'], { quoteRefs: ['older', 'excerpt'] });
  assert.deepEqual(replyReferencesForRows([user, proactive]).get(proactive), ['u']);
  assert.deepEqual(replyReferencesForRows([user, explicit]).get(explicit), ['u']);
  assert.equal(user.type, 'message');
  if (user.type === 'message') assert.deepEqual(user.message.quoteRefs, ['prior-reply', 'selected excerpt']);
});

test('projection before virtualization prevents a window boundary from inventing a quote', () => {
  const history = Array.from({ length: 300 }, (_, index) => message(String(index), 'agent_reply'));
  const user = message('u', 'user_input'), reply = message('r', 'agent_reply', ['u']);
  const rows = [...history, user, separator, reply];
  const references = replyReferencesForRows(rows);
  assert.deepEqual(references.get(rows.at(-1)!), []);
  assert.equal(references.size, 302);
});

test('removing the visible routing quote preserves receipt and delegation association truth', () => {
  const user = message('u', 'user_input'), reply = message('r', 'agent_reply', ['u']);
  const before = JSON.stringify([user, reply]);
  replyReferencesForRows([user, reply]);
  assert.equal(JSON.stringify([user, reply]), before);
  assert.ok(repliedUserIds([user, reply].flatMap(row => row.type === 'message' ? [row.message] : [])).has('u'));
});

test('quote authors come from the actual source role; unknown sources do not borrow the bot identity', () => {
  const messages = [
    normalizeBotMessage({ id: 'u', kind: 'user_input', role: 'user', content: '用户原文' })!,
    normalizeBotMessage({ id: 'b', kind: 'agent_reply', role: 'assistant', content: '机器人原文' })!,
    normalizeBotMessage({ id: 's', kind: 'system_card', role: 'system', content: '系统记录' })!,
  ];
  const anchors = replyAnchorsForMessages(messages, { user: '你', bot: '代码维护' });
  assert.deepEqual(anchors.get('u'), { author: '你', excerpt: '用户原文' });
  assert.deepEqual(anchors.get('b'), { author: '代码维护', excerpt: '机器人原文' });
  assert.deepEqual(anchors.get('s'), { author: null, excerpt: '系统记录' });
  assert.equal(anchors.get('unloaded-id'), undefined);
  assert.equal(replyAnchorsForMessages(messages, { user: 'You', bot: 'Code maintenance' }).get('u')?.author, 'You');
});

test('quote display preserves the full excerpt and source without changing canonical content', () => {
  const content = '一段很长的引用内容😀'.repeat(80);
  const source = normalizeBotMessage({ id: 'full', kind: 'agent_reply', role: 'assistant', content: `\n ${content}\n` })!;
  const before = JSON.stringify(source);
  assert.equal(replyAnchorsForMessages([source], { user: '你', bot: 'Bot' }).get('full')?.excerpt, content);
  assert.equal(JSON.stringify(source), before);
  const imageOnly = normalizeBotMessage({ id: 'image', kind: 'user_input', role: 'user', content: '' })!;
  assert.deepEqual(replyAnchorsForMessages([imageOnly], { user: '你', bot: 'Bot' }).get('image'), { author: '你', excerpt: '' });
});
