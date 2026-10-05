import assert from 'node:assert/strict';
import test from 'node:test';
import { runMemoryCuratorTurn } from './memory-curator-turn.mjs';

test('memory curator carries the resolved bot effort into its governed turn', async () => {
  let input;
  const result = await runMemoryCuratorTurn({
    request: { workspaceId: 'ws', messages: [{ role: 'user', content: 'organize' }] },
    resolveRoute: request => {
      assert.deepEqual(request, { role: 'memory_curator', workspaceId: 'ws' });
      return { ok: true, selection: { modelProviderId: 'curator', reasoningEffort: 'high' } };
    },
    runTurn: async request => { input = request; },
    createSink: () => ({ getText: () => '{"candidates":[]}' }),
  });
  assert.equal(input.turnProfile.modelSelection.reasoningEffort, 'high');
  assert.equal(input.modelProviderId, 'curator');
  assert.equal(input.ephemeral, true);
  assert.equal(input.conversationId, null);
  assert.equal(result.text, '{"candidates":[]}');
});

test('a blocked curator route does not start a turn', async () => {
  let calls = 0;
  const result = await runMemoryCuratorTurn({ resolveRoute: () => ({ ok: false, reason: 'reasoning' }),
    runTurn: async () => { calls++; } });
  assert.equal(calls, 0);
  assert.equal(result.skipped, 'reasoning');
});
