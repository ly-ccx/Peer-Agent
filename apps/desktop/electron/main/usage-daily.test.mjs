import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildUsageDailySnapshot,
  normalizeUsageDailyRange,
  toLocalDateKey,
} from './usage-daily.mjs';

test('normalizeUsageDailyRange falls back to 1m', () => {
  assert.equal(normalizeUsageDailyRange('6m'), '6m');
  assert.equal(normalizeUsageDailyRange('nope'), '1m');
});

test('buildUsageDailySnapshot fills empty range with zeros', () => {
  const now = new Date(2026, 6, 19, 15, 0, 0); // local Jul 19 2026
  const snap = buildUsageDailySnapshot({ rows: [], range: '7d', now });
  assert.equal(snap.range, '7d');
  assert.equal(snap.days.length, 7);
  assert.equal(snap.totals.totalTokens, 0);
  assert.equal(snap.totals.activeDayCount, 0);
  assert.equal(snap.notes.emptyLog, true);
  assert.equal(snap.days[0].date, '2026-07-13');
  assert.equal(snap.days[6].date, '2026-07-19');
  for (const day of snap.days) {
    assert.equal(day.totalTokens, 0);
    assert.equal(day.requestCount, 0);
  }
});

test('buildUsageDailySnapshot aggregates by local day and ignores out-of-range rows', () => {
  const now = new Date(2026, 6, 19, 18, 30, 0);
  const rows = [
    {
      at: new Date(2026, 6, 19, 9, 0, 0).toISOString(),
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 5,
      cacheWriteTokens: 1,
      estimatedCostUsd: 0.01,
    },
    {
      at: new Date(2026, 6, 19, 20, 0, 0).toISOString(),
      inputTokens: 50,
      outputTokens: 10,
      estimatedCostUsd: 0.02,
    },
    {
      at: new Date(2026, 6, 18, 12, 0, 0).toISOString(),
      inputTokens: 30,
      outputTokens: 0,
    },
    {
      // outside 7d window
      at: new Date(2026, 5, 1, 12, 0, 0).toISOString(),
      inputTokens: 9999,
      outputTokens: 9999,
    },
  ];

  const snap = buildUsageDailySnapshot({ rows, range: '7d', now });
  assert.equal(snap.days.length, 7);
  const today = snap.days.find((d) => d.date === '2026-07-19');
  const yesterday = snap.days.find((d) => d.date === '2026-07-18');
  assert.ok(today);
  assert.ok(yesterday);
  assert.equal(today.inputTokens, 150);
  assert.equal(today.outputTokens, 30);
  assert.equal(today.cacheReadTokens, 5);
  assert.equal(today.cacheWriteTokens, 1);
  assert.equal(today.totalTokens, 186);
  assert.equal(today.requestCount, 2);
  assert.equal(today.estimatedCostUsd, 0.03);
  assert.equal(yesterday.totalTokens, 30);
  assert.equal(yesterday.requestCount, 1);
  assert.equal(yesterday.estimatedCostUsd, null);
  assert.equal(snap.totals.requestCount, 3);
  assert.equal(snap.totals.activeDayCount, 2);
  assert.equal(snap.totals.maxTokens, 186);
  assert.equal(snap.notes.emptyLog, false);
});

test('toLocalDateKey uses local calendar day', () => {
  const d = new Date(2026, 0, 5, 23, 30, 0);
  assert.equal(toLocalDateKey(d), '2026-01-05');
});

test('1y range spans 365 days', () => {
  const now = new Date(2026, 6, 19, 12, 0, 0);
  const snap = buildUsageDailySnapshot({ rows: [], range: '1y', now });
  assert.equal(snap.days.length, 365);
  assert.equal(snap.startDate, '2025-07-20');
  assert.equal(snap.endDate, '2026-07-19');
});
