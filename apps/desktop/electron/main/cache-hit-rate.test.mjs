import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeCacheHitRateMetrics,
  hitRate,
  isNoCacheChannel,
  STEADY_TTL_MS,
} from './cache-hit-rate.mjs';

const T0 = '2026-08-08T00:00:00.000Z';

function row(overrides) {
  return {
    at: T0,
    conversationId: 'conv-1',
    providerName: 'Provider A',
    model: 'model-x',
    inputTokens: 1000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...overrides,
  };
}

test('hitRate computes token-weighted rate', () => {
  assert.equal(hitRate({ cacheReadTokens: 900, inputTokens: 100 }), 0.9);
  assert.equal(hitRate({ cacheReadTokens: 0, inputTokens: 0 }), null);
  assert.equal(hitRate({ cacheReadTokens: 0, inputTokens: 100 }), 0);
});

test('isNoCacheChannel detects empty provider and zeus gateway', () => {
  assert.equal(isNoCacheChannel({ providerName: '' }), true);
  assert.equal(isNoCacheChannel({ providerName: 'zeus/claude-opus' }), true);
  assert.equal(isNoCacheChannel({ providerName: 'Grok 官方' }), false);
  assert.equal(isNoCacheChannel({}), true);
});

test('raw hit rate includes all records', () => {
  const rows = [
    row({ at: T0, cacheReadTokens: 9000, inputTokens: 1000 }),
    row({ at: new Date(new Date(T0).getTime() + 60_000).toISOString(), cacheReadTokens: 0, inputTokens: 500 }),
  ];
  const metrics = computeCacheHitRateMetrics(rows);
  // raw = 9000 / (9000 + 1500) = 0.857
  assert.equal(metrics.raw.count, 2);
  assert.ok(Math.abs(metrics.raw.hitRate - 9000 / 10500) < 1e-9);
});

test('steady hit rate excludes first round and expired rounds', () => {
  const t = (ms) => new Date(new Date(T0).getTime() + ms).toISOString();
  const rows = [
    // conv-1: first round (excluded from steady), then steady round, then expired round (gap > 5min)
    row({ conversationId: 'c1', at: t(0), inputTokens: 1000, cacheReadTokens: 0 }),
    row({ conversationId: 'c1', at: t(60_000), inputTokens: 100, cacheReadTokens: 900 }),
    row({ conversationId: 'c1', at: t(STEADY_TTL_MS + 120_000), inputTokens: 2000, cacheReadTokens: 0 }),
  ];
  const metrics = computeCacheHitRateMetrics(rows);
  assert.equal(metrics.byForm.first.count, 1);
  assert.equal(metrics.byForm.expired.count, 1);
  assert.equal(metrics.byForm.steady.count, 1);
  assert.equal(metrics.steady.hitRate, 0.9); // only the steady round
});

test('no-cache channels are excluded from steady and counted separately', () => {
  const rows = [
    row({ providerName: '', inputTokens: 1000, cacheReadTokens: 0 }),
    row({ providerName: 'zeus/claude-opus', inputTokens: 1000, cacheReadTokens: 0 }),
    row({ providerName: 'Grok 官方', inputTokens: 100, cacheReadTokens: 900 }),
  ];
  const metrics = computeCacheHitRateMetrics(rows);
  assert.equal(metrics.noCache.count, 2);
  assert.equal(metrics.raw.count, 3);
  // 单轮会话：首轮被排除，无后续轮 → steady 0
  assert.equal(metrics.steady.count, 0);
  assert.equal(metrics.steady.hitRate, null);
});

test('byChannel reports raw and steady rates with capability flag', () => {
  const t = (ms) => new Date(new Date(T0).getTime() + ms).toISOString();
  const rows = [
    row({ providerName: 'Grok 官方', model: 'grok-4.5', at: t(0), inputTokens: 1000, cacheReadTokens: 0 }),
    row({ providerName: 'Grok 官方', model: 'grok-4.5', at: t(60_000), inputTokens: 100, cacheReadTokens: 900 }),
    row({ providerName: 'zeus/claude', model: 'opus', at: t(0), inputTokens: 500, cacheReadTokens: 0 }),
  ];
  const metrics = computeCacheHitRateMetrics(rows);
  const grok = metrics.byChannel.find((c) => c.model === 'grok-4.5');
  assert.ok(grok);
  assert.equal(grok.rawHitRate, 900 / 2000);
  assert.equal(grok.steadyHitRate, 0.9);
  assert.equal(grok.steadyCount, 1);
  // zeus is no-cache, so not in byChannel
  assert.equal(metrics.byChannel.some((c) => c.model === 'opus'), false);
});
