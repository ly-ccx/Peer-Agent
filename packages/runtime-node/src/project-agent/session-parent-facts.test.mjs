import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionParentFacts } from './session-parent-facts.mjs';
import { anchorRequestsReview } from './acceptance.mjs';

test('parent facts retain exact review anchors and formal citations without execution bodies', () => {
  const history = { messages: [
    { id: 'anchor', kind: 'user_input', content: '先让我确认这次结果', attachments: [{ data: 'private attachment' }] },
    { id: 'internal', kind: 'agent_turn', content: '', rounds: [{ thinking: 'private thinking'.repeat(10000), result: 'private Tool Result' }] },
    { id: 'reply', kind: 'agent_reply', content: 'Done', sources: ['a'], meta: { sources: ['b'], unrelated: 'private metadata' } },
  ] };
  for (const store of [{ createHistoryProjection: project => () => project(history) }, { getPersistedConversationHistory: () => history }]) {
    const rows = createSessionParentFacts(store)('parent');
    assert.equal(anchorRequestsReview(rows.find(row => row.id === 'anchor').content), true);
    const reply = rows.find(row => row.id === 'reply');
    assert.deepEqual(reply.sources, ['a']); assert.deepEqual(reply.meta.sources, ['b']);
    reply.sources.push('caller mutation'); assert.deepEqual(history.messages[2].sources, ['a']);
    assert.ok(!JSON.stringify(rows).includes('private'));
    assert.ok(JSON.stringify(rows).length < 500);
  }
});
