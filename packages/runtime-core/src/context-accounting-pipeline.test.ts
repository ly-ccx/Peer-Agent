import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createContextAccountingCompactionPipeline,
  normalizeObservedInputTokens,
} from './context-accounting-pipeline.ts';

test('provider observed usage is authoritative and triggers compaction before the next send', async () => {
  const compactReasons: string[] = [];
  const pipeline = createContextAccountingCompactionPipeline({
    contextWindow: 500_000,
    buildRequest: (state: { messages: string[] }) => ({ messages: [...state.messages] }),
    compact: async ({ state, reason }) => {
      compactReasons.push(reason);
      return {
        compacted: true,
        state: { messages: ['compacted handoff'] },
      };
    },
    send: async () => ({
      ok: true,
      usage: { inputTokens: 120_000, cacheReadTokens: 0 },
    }),
    getUsage: (response) => response.usage,
  });

  const result = await pipeline.execute({
    state: { messages: ['large history'] },
    lastObservedUsage: { inputTokens: 498_138, cacheReadTokens: 0 },
  });

  assert.deepEqual(compactReasons, ['observed_threshold']);
  assert.equal(result.compactionEpoch, 1);
  assert.equal(result.snapshot.lastObserved?.inputTokens, 120_000);
  assert.equal(result.snapshot.lastObserved?.source, 'provider_usage');
  assert.equal(result.snapshot.nextCounted, undefined);
});

test('Grok prompt overflow enters the same emergency compaction and single retry path', async () => {
  let sends = 0;
  let compactions = 0;
  const pipeline = createContextAccountingCompactionPipeline({
    contextWindow: 500_000,
    buildRequest: (state: { messages: string[] }) => ({ messages: [...state.messages] }),
    compact: async ({ state }) => {
      compactions += 1;
      return { compacted: true, state: { messages: state.messages.slice(-1) } };
    },
    send: async () => {
      sends += 1;
      if (sends === 1) {
        throw new Error(
          "This model's maximum prompt length is 500000 but the request contains 501244 tokens.",
        );
      }
      return { ok: true, usage: { inputTokens: 100_000 } };
    },
    getUsage: (response) => response.usage,
  });

  const result = await pipeline.execute({ state: { messages: ['old', 'latest'] } });

  assert.equal(sends, 2);
  assert.equal(compactions, 1);
  assert.equal(result.retriedAfterOverflow, true);
  assert.equal(result.snapshot.lastOverflow?.requestedTokens, 501_244);
  assert.equal(result.snapshot.lastOverflow?.maximumTokens, 500_000);
});

test('normalizes observed input without double-counting provider cache fields', () => {
  assert.equal(
    normalizeObservedInputTokens({
      inputTokens: 498_138,
      cacheReadTokens: 3_000,
      inputIncludesCache: true,
    }),
    498_138,
  );
  assert.equal(
    normalizeObservedInputTokens({
      inputTokens: 20,
      cacheReadTokens: 80,
      inputIncludesCache: false,
    }),
    100,
  );
});
