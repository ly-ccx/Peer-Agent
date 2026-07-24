import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTEXT_PROJECTION_CONFIG,
  decideContextCompaction,
  estimateContextMessagesTokens,
  estimateContextToolsTokens,
  projectContext,
} from './context-projection.ts';

test('projects one next-request value from messages, tools and draft', () => {
  const messages = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: { path: '/tmp/a' } }] },
  ];
  const tools = [{ name: 'read', description: 'Read a file', input_schema: { type: 'object' } }];
  const projection = projectContext({
    messages,
    tools,
    draftTokens: 9,
    currentInputTokens: 120,
    contextWindow: 1_000,
    phase: 'request_preflight',
    now: 42,
  });
  assert.equal(projection.version, 1);
  assert.equal(projection.updatedAt, 42);
  assert.equal(projection.nextRequestInputTokens, estimateContextMessagesTokens(messages) + estimateContextToolsTokens(tools) + 9);
  assert.equal(projection.compactionPressureTokens, projection.nextRequestInputTokens);
  assert.equal(projection.quality, 'projected');
});

test('stream preview changes display pressure without changing the request projection', () => {
  const projection = projectContext({
    messages: [{ role: 'user', content: 'small' }],
    previewInputTokens: 690,
    contextWindow: 1_000,
    phase: 'stream_preview',
  });
  assert.ok((projection.nextRequestInputTokens ?? 0) < 690);
  assert.equal(projection.previewInputTokens, 690);
  assert.equal(projection.compactionPressureTokens, 690);
  assert.equal(projection.percent, 69);
  assert.equal(projection.quality, 'preview');
});

test('compaction decisions share soft, hard, overflow and summary-headroom reasons', () => {
  const soft = decideContextCompaction({ pressureTokens: 81, contextWindow: 100 });
  assert.deepEqual([soft.shouldCompact, soft.force, soft.pressure, soft.reason], [true, false, 'soft', 'soft_limit']);

  const hard = decideContextCompaction({ pressureTokens: 93, contextWindow: 100 });
  assert.deepEqual([hard.shouldCompact, hard.force, hard.pressure, hard.reason], [true, true, 'hard', 'hard_limit']);

  const overflow = decideContextCompaction({ pressureTokens: 101, contextWindow: 100 });
  assert.deepEqual([overflow.shouldCompact, overflow.force, overflow.pressure, overflow.reason], [true, true, 'overflow', 'context_overflow']);

  const headroom = decideContextCompaction({ pressureTokens: 76, contextWindow: 100, summaryReserveTokens: 25 });
  assert.deepEqual([headroom.shouldCompact, headroom.force, headroom.reason], [true, false, 'insufficient_summary_headroom']);
});

test('unknown windows never invent a percentage or automatic trigger', () => {
  const projection = projectContext({ messages: [{ role: 'user', content: 'hello' }], phase: 'restored' });
  assert.equal(projection.contextWindow, null);
  assert.equal(projection.percent, null);
  assert.equal(projection.pressure, 'unknown');
  assert.equal(CONTEXT_PROJECTION_CONFIG.triggerRatio, 0.8);
});

test('CJK, image and tool blocks are accounted consistently', () => {
  const plain = estimateContextMessagesTokens([{ role: 'user', content: 'hello' }]);
  const rich = estimateContextMessagesTokens([{
    role: 'user',
    content: [
      { type: 'text', text: '你好世界' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,x' } },
      { type: 'tool_result', tool_use_id: 't1', content: 'result' },
    ],
  }]);
  assert.ok(rich > plain + 2_000);
});
