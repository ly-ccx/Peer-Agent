import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildUsageDaySnapshot,
  collectUsageDay,
  UNBOUND_MODEL_KEY,
} from './usage-day.mjs';

function row({ day, hour = 12, modelProviderId = 'provider-a::model-1', model = 'model-1', providerName = 'provider-a', inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0, providerRequestCount = 1, estimatedCostUsd = null }) {
  return {
    at: new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, 0, 0).toISOString(),
    usageScope: 'runtime_turn',
    modelProviderId,
    model,
    providerName,
    providerRequestCount,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    estimatedCostUsd,
  };
}

const NOW = new Date(2026, 6, 19, 18, 30, 0); // local Jul 19 2026

test('buildUsageDaySnapshot returns empty snapshot for invalid date', () => {
  const snap = buildUsageDaySnapshot({ rows: [], date: 'nope', now: NOW });
  assert.equal(snap.date, null);
  assert.equal(snap.totals.totalTokens, 0);
  assert.equal(snap.totals.requestCount, 0);
  assert.equal(snap.totals.modelCount, 0);
  assert.equal(snap.hours.length, 24);
  assert.equal(snap.notes.emptyDay, true);
});

test('buildUsageDaySnapshot returns zeroed 24h for valid date without matching rows', () => {
  const snap = buildUsageDaySnapshot({
    rows: [row({ day: NOW, inputTokens: 10 })],
    date: '2026-07-18',
    now: NOW,
  });
  assert.equal(snap.date, '2026-07-18');
  assert.equal(snap.totals.totalTokens, 0);
  assert.equal(snap.totals.requestCount, 0);
  assert.equal(snap.notes.emptyDay, true);
  assert.equal(snap.hours.length, 24);
  for (const h of snap.hours) assert.equal(h.totalTokens, 0);
});

test('buildUsageDaySnapshot filters to target local day only', () => {
  const rows = [
    row({ day: NOW, hour: 9, inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 1, estimatedCostUsd: 0.01 }),
    row({ day: NOW, hour: 20, inputTokens: 50, outputTokens: 10, estimatedCostUsd: 0.02 }),
    // 前一天 / 后一天不应计入。
    row({ day: new Date(2026, 6, 18, 12, 0, 0), inputTokens: 9999 }),
    row({ day: new Date(2026, 6, 20, 12, 0, 0), inputTokens: 9999 }),
  ];
  const snap = buildUsageDaySnapshot({ rows, date: '2026-07-19', now: NOW });
  assert.equal(snap.date, '2026-07-19');
  assert.equal(snap.totals.totalTokens, 186);
  assert.equal(snap.totals.requestCount, 2);
  assert.equal(snap.totals.estimatedCostUsd, 0.03);
  assert.equal(snap.totals.modelCount, 1);
  assert.equal(snap.notes.emptyDay, false);
  assert.equal(snap.hours[9].totalTokens, 126);
  assert.equal(snap.hours[20].totalTokens, 60);
  assert.equal(snap.hours[9].requestCount, 1);
});

test('buildUsageDaySnapshot splits usage by model with label and unbound fallback', () => {
  const rows = [
    row({ day: NOW, hour: 8, modelProviderId: 'provider-a::model-1', model: 'model-1', inputTokens: 30, outputTokens: 10, estimatedCostUsd: 0.01 }),
    row({ day: NOW, hour: 9, modelProviderId: 'provider-a::model-1', model: 'model-1', inputTokens: 20, outputTokens: 5, estimatedCostUsd: null }),
    row({ day: NOW, hour: 10, modelProviderId: 'provider-b::model-2', model: 'model-2', inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0.02 }),
    row({ day: NOW, hour: 11, modelProviderId: '', model: '', providerName: 'legacy-provider', inputTokens: 7, outputTokens: 3, estimatedCostUsd: null }),
  ];
  const snap = buildUsageDaySnapshot({ rows, date: '2026-07-19', now: NOW });
  assert.equal(snap.totals.modelCount, 3);

  const model1 = snap.byModel.find((m) => m.key === 'provider-a::model-1');
  assert.ok(model1);
  assert.equal(model1.label, 'model-1');
  assert.equal(model1.inputTokens, 50);
  assert.equal(model1.outputTokens, 15);
  assert.equal(model1.totalTokens, 65);
  assert.equal(model1.requestCount, 2);
  assert.equal(model1.estimatedCostUsd, 0.01);

  const model2 = snap.byModel.find((m) => m.key === 'provider-b::model-2');
  assert.ok(model2);
  assert.equal(model2.label, 'model-2');
  assert.equal(model2.totalTokens, 150);
  assert.equal(model2.estimatedCostUsd, 0.02);

  const unbound = snap.byModel.find((m) => m.key === UNBOUND_MODEL_KEY);
  assert.ok(unbound);
  assert.equal(unbound.label, 'legacy-provider');
  assert.equal(unbound.modelProviderId, null);
  assert.equal(unbound.totalTokens, 10);
  assert.equal(unbound.estimatedCostUsd, null);

  // 排序：有成本的在前，其次 token 多。
  assert.deepEqual(snap.byModel.map((m) => m.key), [
    'provider-b::model-2',
    'provider-a::model-1',
    UNBOUND_MODEL_KEY,
  ]);
});

test('buildUsageDaySnapshot weights requestCount by providerRequestCount', () => {
  const rows = [
    row({ day: NOW, hour: 3, providerRequestCount: 3, inputTokens: 30, outputTokens: 0 }),
    row({ day: NOW, hour: 3, providerRequestCount: 1, inputTokens: 10, outputTokens: 0 }),
  ];
  const snap = buildUsageDaySnapshot({ rows, date: '2026-07-19', now: NOW });
  assert.equal(snap.totals.requestCount, 4);
  assert.equal(snap.hours[3].requestCount, 4);
  assert.equal(snap.hours[3].totalTokens, 40);
});

test('buildUsageDaySnapshot reports null cost when nothing is priced', () => {
  const rows = [
    row({ day: NOW, hour: 2, inputTokens: 10, estimatedCostUsd: null }),
    row({ day: NOW, hour: 4, inputTokens: 20, estimatedCostUsd: null }),
  ];
  const snap = buildUsageDaySnapshot({ rows, date: '2026-07-19', now: NOW });
  assert.equal(snap.totals.estimatedCostUsd, null);
  assert.equal(snap.totals.pricedRequestCount, 0);
  assert.equal(snap.byModel[0].estimatedCostUsd, null);
});

test('collectUsageDay reads rows from the request log', () => {
  const usageRequestLog = {
    readAll: ({ limit }) => {
      assert.equal(limit, 200_000);
      return [row({ day: NOW, hour: 5, inputTokens: 42, estimatedCostUsd: 0.005 })];
    },
  };
  const snap = collectUsageDay({ date: '2026-07-19', now: NOW, usageRequestLog });
  assert.equal(snap.totals.totalTokens, 42);
  assert.equal(snap.totals.estimatedCostUsd, 0.005);
  assert.equal(snap.hours[5].totalTokens, 42);
});

test('collectUsageDay builds labelIndex from llmConfigStore providers', () => {
  const usageRequestLog = {
    readAll: () => [
      row({ day: NOW, hour: 6, modelProviderId: 'uuid-1', model: 'cmodel', providerName: 'Fixture Provider', inputTokens: 30, outputTokens: 5, estimatedCostUsd: 0.005 }),
    ],
  };
  const llmConfigStore = {
    listProviders: () => [
      { id: 'uuid-1', model: 'cmodel', modelLabel: 'Cantus' },
      { id: 'uuid-2', model: 'gm51model', modelLabel: 'GLM-5.2' },
    ],
  };
  const snap = collectUsageDay({ date: '2026-07-19', now: NOW, usageRequestLog, llmConfigStore });
  assert.equal(snap.byModel.length, 1);
  assert.equal(snap.byModel[0].label, 'Cantus');
  assert.equal(snap.byModel[0].providerName, 'Fixture Provider');
});
