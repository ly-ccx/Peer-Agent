import assert from 'node:assert/strict';
import test from 'node:test';

import { roundsForReply } from '../state/botConversationState.ts';
import { agentProcessEntries } from './agentProcess.ts';
import { normalizeBotMessage } from '../state/botConversationState.ts';

test('过程按回复 turnId 精确关联，包括回复先于 agent_turn 落库的顺序', () => {
  const old = normalizeBotMessage({ id: 'old', kind: 'agent_turn', rounds: [{ toolCalls: [{ name: 'post_reply', input: { text: '旧回复' } }] }] })!;
  const reply = normalizeBotMessage({ id: 'new-reply', kind: 'agent_reply', turnId: 'new', content: '本轮回复' })!;
  const current = normalizeBotMessage({ id: 'new', kind: 'agent_turn', rounds: [{ toolCalls: [{ name: 'list_sessions', result: { ok: true, sessions: [] } }] }] })!;
  assert.deepEqual(roundsForReply([old, reply, current], reply.id), current.rounds);
  assert.deepEqual(roundsForReply([old, reply], reply.id), []);
});

test('post_reply 显示发送操作，嵌套拒绝与静默不能显示为发送成功', () => {
  const entries = agentProcessEntries([{ text: '', toolCalls: [
    { name: 'post_reply', input: { text: '回复正文' }, result: { ok: true, output: { ok: true } } },
    { name: 'post_reply', input: {}, result: { ok: true, output: { ok: false, error: 'denied' } } },
    { name: 'post_reply', input: {}, result: { ok: true, output: { suppressed: true } } },
    { name: 'external_extension', input: {}, result: null },
  ] }]);
  assert.equal(entries[0]?.labelKey, 'projectAgent.process.reply');
  assert.deepEqual(entries.map(entry => entry.status), ['done', 'failed', 'suppressed', 'unknown']);
  assert.equal(entries[0]?.summary, '');
  assert.equal(entries[3]?.labelKey, 'projectAgent.process.tool');
});

test('代理过程只列出回复前面那一轮的工具调用和结果', () => {
  const rounds = [{
    text: '',
    toolCalls: [
      { name: 'get_verification_detail', input: { sessionId: 's-1' }, result: { outcome: 'passed' } },
    ],
  }];
  const messages = [
    { id: 'turn', kind: 'agent_turn', role: 'assistant', content: '', createdAt: '', replyTo: [], sources: [], marks: [], dispositions: [], rounds, meta: {}, proactive: false, cards: [], quoteRefs: [], separatorLabel: '' },
    { id: 'reply', kind: 'agent_reply', role: 'assistant', content: '好了', createdAt: '', replyTo: [], sources: [], marks: [], dispositions: [], rounds: [], meta: {}, proactive: false, cards: [], quoteRefs: [], separatorLabel: '' },
  ];
  assert.equal(roundsForReply(messages, 'reply'), rounds);
  const [entry] = agentProcessEntries(roundsForReply(messages, 'reply'));
  assert.equal(entry?.name, 'get_verification_detail');
  assert.deepEqual(JSON.parse(entry!.input), { sessionId: 's-1' });
  assert.deepEqual(JSON.parse(entry!.result), { outcome: 'passed' });
  assert.deepEqual(agentProcessEntries([]), []);
});
