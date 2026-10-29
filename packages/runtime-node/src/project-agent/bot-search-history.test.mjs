import test from 'node:test';
import assert from 'node:assert/strict';
import { projectBotSearchHistory, createBotSearchHistory } from './bot-search-history.mjs';
import { collectConversationSearchDocuments } from './conversation-search-index.mjs';
import { createHistoryProjectionReader } from '../../../conversation-store/src/history-projection-reader.mjs';

test('search projection preserves complete public search documents and excludes private process bodies', () => {
  const messages = [
    { id: 'user', kind: 'user_input', role: 'user', content: 'full public body '.repeat(200), createdAt: '2026-10-28' },
    { id: 'reply', kind: 'agent_reply', role: 'assistant', text: 'legacy text fallback' },
    { id: 'typed', type: 'user_input', text: 'legacy type field' },
    { id: 'message-kind', messageKind: 'agent_reply', text: 'legacy message kind field' },
    { id: 'hidden', kind: 'agent_turn', role: 'assistant', content: 'private reasoning', rounds: [{ text: 'private tool parameters' }] },
    { id: 'activity', kind: 'agent_activity', role: 'assistant', content: 'verified hidden', agentActivity: { state: 'verified' } },
  ];
  const docs = rows => collectConversationSearchDocuments({ messages: rows.map(message => ({ workspaceId: 'ws', message })) });
  const projected = projectBotSearchHistory({ messages });
  assert.deepEqual(docs(projected), docs(messages));
  assert.ok(!JSON.stringify(projected).includes('private'));
  assert.ok(projected[0].content.length > 80, 'search must retain the complete public text');
});

test('search history keeps bounded immutable projections warm and refreshes changed and removed sources', () => {
  const versions = new Map(Array.from({ length: 200 }, (_, id) => [String(id), 1])); let loads = 0;
  const store = { createHistoryProjection(project, options) {
    assert.equal(options.maxEntries, 512); assert.equal(options.maxBytes, 8 * 1024 * 1024);
    return createHistoryProjectionReader({ ...options, project,
      describe: id => versions.has(id) ? { id, version: versions.get(id) } : null,
      load: ({ id }) => { loads++; return { messages: [{ id, kind: 'agent_reply', content: 'revision ' + versions.get(id) }] }; },
    });
  } };
  const read = createBotSearchHistory(store);
  for (let round = 0; round < 3; round++) for (const id of versions.keys()) assert.equal(read(id)[0].content, 'revision 1');
  assert.equal(loads, 200);
  assert.throws(() => { read('0')[0].content = 'forged'; }, TypeError);
  versions.set('0', 2); assert.equal(read('0')[0].content, 'revision 2'); assert.equal(loads, 201);
  versions.delete('0'); assert.equal(read('0'), null);
});
