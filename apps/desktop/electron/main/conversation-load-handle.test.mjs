import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createConversationLoadHandle } from './conversation-load-handle.mjs';

test('a load handle reads the conversation store once', () => {
  let reads = 0;
  const stored = { id: 'c1', workspacePath: '/ws', messages: [{ role: 'user', content: 'hello' }] };
  const handle = createConversationLoadHandle({
    getConversation(id) {
      reads += 1;
      assert.equal(id, 'c1');
      return stored;
    },
  }, 'c1');

  assert.equal(handle.load(), stored);
  assert.equal(handle.load(), stored);
  assert.equal(reads, 1);
});

test('handleChatSend uses one shared load handle and canonical history projection', async () => {
  const main = await readFile(new URL('./main.mjs', import.meta.url), 'utf8');
  const sendStart = main.indexOf('function handleChatSend');
  const sendEnd = main.indexOf('// ── Stream reattach', sendStart);
  const sendFn = main.slice(sendStart, sendEnd);
  assert.match(sendFn, /createConversationLoadHandle\(conversationStore, conversationId\)/);
  assert.doesNotMatch(sendFn, /conversationStore\.getConversation\(/);
  assert.match(sendFn, /projectConversationHistory\(persistedConversation\.messages\)/);
});
