import assert from 'node:assert/strict';
import test from 'node:test';

import { roundsForReply } from '../state/botConversationState.ts';
import { agentProcessEntries } from './agentProcess.ts';

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
  assert.deepEqual(agentProcessEntries(roundsForReply(messages, 'reply')), [
    { name: 'get_verification_detail', input: '{"sessionId":"s-1"}', result: '{"outcome":"passed"}' },
  ]);
  assert.deepEqual(agentProcessEntries([]), []);
});
