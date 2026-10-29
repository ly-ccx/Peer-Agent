import assert from 'node:assert/strict';
import test from 'node:test';

import { recordDetachedTurnUsage } from './background-turn-usage.mjs';

test('没有会话的整理回合仍把用量写入请求日志', () => {
  const rows = [];
  const recorded = recordDetachedTurnUsage({
    streamRecord: {
      streamId: 'stream-1',
      modelProviderId: 'model-eco',
      turnProfile: { role: 'memory_curator', workspaceId: 'ws-1' },
      actualPricing: {},
    },
    usage: { inputTokens: 12, outputTokens: 4, providerRequestCount: 1 },
    usageRequestLog: {
      append(entry) {
        rows.push(entry);
        return entry;
      },
    },
  });
  assert.equal(recorded.conversationId, null);
  assert.equal(recorded.role, 'memory_curator');
  assert.equal(recorded.workspaceId, 'ws-1');
  assert.equal(rows.length, 1);
  assert.equal(recordDetachedTurnUsage({
    streamRecord: { streamId: 'empty' },
    usage: { inputTokens: 0 },
    usageRequestLog: { append() { return { wrote: true }; } },
  }), null);
});
