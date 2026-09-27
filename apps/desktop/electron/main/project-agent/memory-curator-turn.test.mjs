import assert from 'node:assert/strict';
import test from 'node:test';

import { curatorModelProviderId, runMemoryCuratorTurn } from './memory-curator-turn.mjs';

test('没有已保存的省档路由时不指定模型', () => {
  assert.equal(curatorModelProviderId(null), null);
  assert.equal(curatorModelProviderId({}), null);
});

test('整理回合是临时的 memory_curator，省档来自已保存路由', async () => {
  const seen = [];
  const result = await runMemoryCuratorTurn({
    request: {
      workspaceId: 'ws-1',
      excludeCapabilityPrefixes: ['local.'],
      messages: [{ role: 'user', content: 'Episode: {}' }],
    },
    getSettings: () => ({
      modelRouting: { tiers: { economy: { primary: 'model-eco', fallbacks: [] } } },
    }),
    createSink() {
      return {
        send() {},
        getText() { return '{"candidates":[]}'; },
      };
    },
    async runTurn(input) {
      seen.push(input);
    },
  });
  assert.equal(result.text, '{"candidates":[]}');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].ephemeral, true);
  assert.equal(seen[0].conversationId, null);
  assert.equal(seen[0].mode, 'memory_curator');
  assert.equal(seen[0].turnProfile.role, 'memory_curator');
  assert.equal(seen[0].turnProfile.workspaceId, 'ws-1');
  assert.equal(seen[0].modelProviderId, 'model-eco');
  assert.deepEqual(seen[0].turnProfile.modelSelection, { modelProviderId: 'model-eco', source: 'routing' });
  assert.deepEqual(seen[0].turnProfile.excludeCapabilityPrefixes, ['local.']);
  assert.equal(typeof seen[0].streamId, 'string');
});
