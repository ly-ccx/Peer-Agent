import test from 'node:test';
import assert from 'node:assert/strict';
import { createLlmChatService } from './llm-chat-service.mjs';

// Actual send entry and provider encoder, with only HTTP transport replaced.
test('child send admits frozen background once as user material and hides executable tools', async (t) => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response('data: {"choices":[{"delta":{"content":"answer"}}]}\n\ndata: [DONE]\n\n', { status: 200 });
  };
  const store = {
    getConversation: (id) => ({ contentRevision: 0, ...(id === 'child' ? {
      selectionOrigin: { parentConversationId: 'parent', snapshotId: 'snapshot' },
    } : {}) }),
    readInheritedBackground: () => ({ sourceConversationId: 'parent', sourceRevision: 1,
      capturedAt: '2026-09-06', status: 'full', missingItems: [],
      entries: [{ sourceRole: 'user', text: 'FROZEN_PARENT_ONLY' }] }),
  };
  const service = createLlmChatService({ conversationStore: store, llmConfigStore: {
    listProviders: () => [{ id: 'p', provider: 'openai', baseUrl: 'https://example.test/v1',
      model: 'test-model', isDefault: true, apiKeyConfigured: true, contextWindow: 128000 }],
    getDecryptedApiKey: () => 'test-key',
  } });
  for (const id of ['child', 'parent', 'child']) {
    const events = [];
    const result = await service.sendMessage({ conversationId: id, streamId: `${id}-${bodies.length}`,
      messages: [{ role: 'user', content: 'my question' }],
      webContents: { send: (channel, payload) => events.push({ channel, payload }) } });
    assert.equal(result.terminalStatus, 'done', JSON.stringify(events));
  }
  assert.equal(bodies.length, 3);
  for (const i of [0, 2]) {
    assert.equal(JSON.stringify(bodies[i]).split('FROZEN_PARENT_ONLY').length - 1, 1);
    assert.equal(bodies[i].messages.find((m) => JSON.stringify(m.content).includes('FROZEN_PARENT_ONLY')).role, 'user');
    assert.equal(bodies[i].tools?.length ?? 0, 0);
  }
  assert.ok(!JSON.stringify(bodies[1]).includes('FROZEN_PARENT_ONLY'));
});
