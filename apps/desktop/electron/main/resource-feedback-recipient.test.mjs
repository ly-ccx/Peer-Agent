import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveResourceFeedbackRecipient as resolve } from './resource-feedback-recipient.mjs';
const item = { workspaceId: 'bot', profile: { status: 'active', agentConversationId: 'main' } };
test('uses actual metadata ancestry to address the original Bot without changing the source child', () => {
  const conversations = [{ id: 'main' }, { id: 'work', parentConversationId: 'main' }, { id: 'child', parentConversationId: 'work' }];
  assert.deepEqual(resolve('child', { items: [item], conversations }), { workspaceId: 'bot', conversationId: 'main' });
  assert.equal(conversations[2].parentConversationId, 'work');
});
test('missing, archived, cyclic, ambiguous or over-deep ancestry cannot select another recipient', () => {
  const cases = [[{ id: 'child', parentConversationId: 'missing' }], [{ id: 'main', status: 'archived' }],
    [{ id: 'child', parentConversationId: 'child' }], Array.from({ length: 33 }, (_, i) => ({ id: `c-${i}`, parentConversationId: `c-${i + 1}` })).concat({ id: 'main' })];
  for (const conversations of cases) assert.equal(resolve(conversations[0].id, { items: [item], conversations }), null);
  assert.equal(resolve('main', { items: [item, { ...item, workspaceId: 'another' }], conversations: [{ id: 'main' }] }), null);
  assert.equal(resolve('main', { items: [{ ...item, profile: { ...item.profile, status: 'archived' } }], conversations: [{ id: 'main' }] }), null);
});
