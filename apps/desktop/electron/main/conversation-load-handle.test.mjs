import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createConversationLoadHandle } from './conversation-load-handle.mjs';
import { createLlmChatService } from './llm-chat-service.mjs';

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

test('handleChatSend shares one load handle with sendMessage', async () => {
  const [main, service] = await Promise.all([
    readFile(new URL('./main.mjs', import.meta.url), 'utf8'),
    readFile(new URL('./llm-chat-service.mjs', import.meta.url), 'utf8'),
  ]);
  const sendStart = main.indexOf('function handleChatSend');
  const sendEnd = main.indexOf('// ── Stream reattach', sendStart);
  const sendFn = main.slice(sendStart, sendEnd);
  assert.match(sendFn, /createConversationLoadHandle\(conversationStore, conversationId\)/);
  assert.match(sendFn, /conversationLoad,/);
  assert.doesNotMatch(sendFn, /conversationStore\.getConversation\(/);
  assert.match(sendFn, /projectConversationHistory\(persistedConversation\.messages\)/);

  const messageStart = service.indexOf('async function sendMessage');
  const messageEnd = service.indexOf('function forceCompleteConversationStreams', messageStart);
  const messageFn = service.slice(messageStart, messageEnd);
  assert.match(messageFn, /readLoadedConversation\(\)/);
  const directLoads = messageFn.match(/conversationStore\??\.getConversation\??\.\(/g) ?? [];
  assert.deepEqual(directLoads, ['conversationStore?.getConversation?.(']);
  assert.match(messageFn, /Compaction rebuild runs after the summary request/);
});

test('one classic send loads the conversation once and a shared handle is not loaded again', async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  globalThis.fetch = async () => new Response(
    'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
    { status: 200 },
  );

  let reads = 0;
  const stored = {
    id: 'c1',
    workspacePath: '/ws',
    modelProviderId: 'p1',
    contentRevision: 2,
    messageCount: 2,
    messages: [
      { id: 'u', role: 'user', content: 'hello' },
      { id: 'a', role: 'assistant', content: '' },
    ],
    contextSnapshot: null,
  };
  const store = {
    getConversation(id) {
      reads += 1;
      assert.equal(id, 'c1');
      return stored;
    },
  };
  const service = createLlmChatService({
    conversationStore: store,
    goalPlanStore: { getActivePlanByConversation: () => null },
    llmConfigStore: {
      listProviders: () => [{
        id: 'p1',
        provider: 'openai',
        baseUrl: 'https://example.test/v1',
        model: 'test-model',
        isDefault: true,
        apiKeyConfigured: true,
        contextWindow: 128000,
      }],
      getDecryptedApiKey: () => 'test-key',
    },
  });
  const webContents = { send() {} };

  reads = 0;
  const first = await service.sendMessage({
    messages: [{ role: 'user', content: 'hello' }],
    streamId: 's-load-once',
    conversationId: 'c1',
    webContents,
  });
  assert.equal(first.terminalStatus, 'done');
  assert.equal(reads, 1);

  const handle = createConversationLoadHandle(store, 'c1');
  assert.equal(handle.load(), stored);
  reads = 0;
  const second = await service.sendMessage({
    messages: [{ role: 'user', content: 'hello' }],
    streamId: 's-shared-handle',
    conversationId: 'c1',
    conversationLoad: handle,
    webContents,
  });
  assert.equal(second.terminalStatus, 'done');
  assert.equal(reads, 0);
});
