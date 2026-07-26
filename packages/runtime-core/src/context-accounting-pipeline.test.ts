import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createContextAccountingCompactionPipeline,
  createRestoredObservedContextAccountingSnapshot,
  latestObservedUsageFromMessages,
  normalizeObservedInputTokens,
} from './context-accounting-pipeline.ts';

test('provider observed usage is authoritative and triggers compaction before the next send', async () => {
  const compactReasons: string[] = [];
  const pipeline = createContextAccountingCompactionPipeline({
    identity: { conversationId: 'conversation-observed', contentRevision: 1, modelKey: 'grok-4.5' },
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
    identity: { conversationId: 'conversation-overflow', contentRevision: 1, modelKey: 'grok-4.5' },
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

test('restores a numeric provider-observed baseline from the last durable assistant usage', () => {
  const usage = latestObservedUsageFromMessages([
    { role: 'assistant', usage: { input: 10_000, cacheRead: 2_500 } },
    { role: 'user', content: 'next question' },
    { role: 'assistant', usage: { inputTokens: 42_000, cacheReadTokens: 3_000 } },
  ]);

  assert.deepEqual(usage, {
    inputTokens: 42_000,
    cacheReadTokens: 3_000,
  });

  const snapshot = createRestoredObservedContextAccountingSnapshot({
    identity: {
      conversationId: 'conversation-restored-observed',
      contentRevision: 9,
      modelKey: 'provider-a::grok-4.5',
    },
    contextWindow: 500_000,
    countCapability: { kind: 'observed_usage_only' },
    usage,
    pendingUncountedChanges: true,
    now: 456,
  });

  assert.equal(snapshot.phase, 'restored');
  assert.equal(snapshot.authoritativeInputTokens, 45_000);
  assert.equal(snapshot.percent, 9);
  assert.equal(snapshot.pressureSource, 'provider_usage');
  assert.equal(snapshot.pendingUncountedChanges, true);
  assert.equal(snapshot.lastObserved?.inputTokens, 45_000);
});

test('publishes the complete accounting snapshot and degrades a drifting exact counter', async () => {
  const published: Array<{ phase: string; source: string; status: string }> = [];
  const pipeline = createContextAccountingCompactionPipeline({
    identity: { conversationId: 'conversation-counted', contentRevision: 9, modelKey: 'claude-test' },
    contextWindow: 100_000,
    countCapability: { kind: 'provider_count_api' },
    countRequest: () => ({ inputTokens: 10_000, source: 'provider_count_api' }),
    buildRequest: (state: { messages: string[] }) => ({ messages: [...state.messages] }),
    compact: async ({ state }) => ({ compacted: false, state }),
    send: async () => ({ usage: { inputTokens: 12_500 } }),
    getUsage: (response) => response.usage,
    onSnapshot(snapshot, phase) {
      published.push({
        phase,
        source: snapshot.pressureSource,
        status: snapshot.counterStatus,
      });
    },
    now: () => 123,
  });

  const result = await pipeline.execute({ state: { messages: ['hello'] } });

  assert.deepEqual(published, [
    { phase: 'request_preflight', source: 'provider_count_api', status: 'active' },
    { phase: 'turn_complete', source: 'provider_usage', status: 'degraded' },
  ]);
  assert.equal(result.snapshot.conversationId, 'conversation-counted');
  assert.equal(result.snapshot.contentRevision, 9);
  assert.equal(result.snapshot.modelKey, 'claude-test');
  assert.equal(result.snapshot.verification?.status, 'drift');
  assert.equal(result.snapshot.nextCounted, undefined);
  assert.equal(result.snapshot.authoritativeInputTokens, 12_500);
  assert.equal(result.snapshot.percent, 13);
});

test('manual compact is the same pipeline command and never sends', async () => {
  let sends = 0;
  const pipeline = createContextAccountingCompactionPipeline({
    identity: { conversationId: 'conversation-manual', contentRevision: 4, modelKey: 'model-a' },
    contextWindow: 10_000,
    countCapability: { kind: 'unavailable' },
    buildRequest: (state: { messages: string[] }) => ({ messages: [...state.messages] }),
    compact: async () => ({ compacted: true, state: { messages: ['handoff'] } }),
    send: async () => {
      sends += 1;
      return { ok: true };
    },
  });

  const result = await pipeline.execute({
    state: { messages: ['old', 'latest'] },
    command: 'manual_compact',
  });

  assert.equal(sends, 0);
  assert.equal(result.compacted, true);
  assert.equal(result.compactionEpoch, 1);
  assert.equal(result.snapshot.phase, 'post_compaction');
  assert.equal(result.snapshot.authoritativeInputTokens, null);
  assert.equal(result.snapshot.pendingUncountedChanges, true);
});

test('count_only rebuilds restored authority without sending or compacting', async () => {
  let sends = 0;
  let compactions = 0;
  const canonicalRequest = {
    system: 'shared system',
    messages: [{ role: 'user', content: 'restored history' }],
    tools: [{ name: 'read_file' }],
  };
  const pipeline = createContextAccountingCompactionPipeline({
    identity: { conversationId: 'conversation-restored', contentRevision: 7, modelKey: 'model-a' },
    contextWindow: 500_000,
    countCapability: { kind: 'provider_count_api' },
    buildRequest: () => canonicalRequest,
    countRequest: (request) => {
      assert.equal(request, canonicalRequest);
      return { inputTokens: 45_000, source: 'provider_count_api' };
    },
    compact: async ({ state }) => {
      compactions += 1;
      return { compacted: false, state };
    },
    send: async () => {
      sends += 1;
      return { ok: true };
    },
    now: () => 456,
  });

  const result = await pipeline.execute({
    state: null,
    command: 'count_only',
  });

  assert.equal(sends, 0);
  assert.equal(compactions, 0);
  assert.equal(result.response, null);
  assert.equal(result.snapshot.phase, 'restored');
  assert.equal(result.snapshot.authoritativeInputTokens, 45_000);
  assert.equal(result.snapshot.percent, 9);
  assert.equal(result.snapshot.pendingUncountedChanges, false);
});
