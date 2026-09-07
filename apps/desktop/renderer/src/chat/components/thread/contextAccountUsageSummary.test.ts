import test from 'node:test';
import assert from 'node:assert/strict';
import type { LlmSubscriptionQuota } from '@peer-agent/protocol';
import { contextAccountUsageSummary as summary } from './contextAccountUsageSummary.ts';

const cases: Record<string, { quota: LlmSubscriptionQuota; match: RegExp }> = {
  balance: { quota: { success: true, balances: [{ currency: 'CNY', total: '12.34', source: 'api_key', scope: 'account' }] }, match: /12.34/ },
  zero: { quota: { success: true, availableCredits: 0 }, match: /0/ },
  legacy: { quota: { success: true, remainingPercent: 90 }, match: /90%/ },
  count: { quota: { success: true, windows: [{ id: 'session', used: 20, limit: 100 }] }, match: /80/ },
  periods: { quota: { success: true, windows: [{ id: 'week', used: 20, limit: 100 }, { id: 'month', usedPercent: 60 }] }, match: /80 \/ 100.*\n(?:本月剩余可用|Monthly remaining) 40%/ },
  unavailable: { quota: { success: false, status: 'unsupported' }, match: /不可用|unavailable/ },
};
for (const [name, { quota, match }] of Object.entries(cases)) {
  for (const state of ['ready', 'loading', 'stale', 'failed']) {
    for (const zh of [true, false]) test(`summary/${name}/${state}/${zh ? 'zh' : 'en'}`, () => {
      const lines = summary({ ...quota, stale: state === 'stale', success: state === 'failed' ? false : quota.success }, state === 'loading', zh);
      assert.match(lines.join('\n'), match);
      assert.ok(lines.length <= 3);
      assert.doesNotMatch(lines.join('\n'), /本地统计|厂商账户|缓存读取|详细/);
      if (state === 'stale' || state === 'failed') assert.match(lines[0], /过期|outdated/);
    });
  }
}
for (const [id, cn, en] of [['weekly', '本周剩余可用', 'Weekly remaining'], ['monthly', '本月剩余可用', 'Monthly remaining']]) {
  for (const [fields, value] of [
    [{ usedPercent: 13 }, '87%'],
    [{ remainingPercent: 87, usedPercent: 99 }, '87%'],
    [{ used: 13, limit: 100 }, '87 / 100'],
    [{ remaining: 87, used: 99, limit: 100 }, '87 / 100'],
    [{ remainingPercent: 0 }, '0%'],
  ] as const) {
    for (const zh of [true, false]) test(`summary/localized-remaining/${id}/${JSON.stringify(fields)}/${zh}`, () => {
      const lines = summary({ success: true, windows: [{ id, label: id, ...fields }] }, false, zh);
      assert.deepEqual(lines, [`${zh ? cn : en} ${value}`]);
      assert.doesNotMatch(lines.join(''), /已用| used/);
    });
  }
}
const now = Date.parse('2026-09-07T00:00:00Z');
for (const id of ['session', 'weekly', 'monthly']) {
  for (const zh of [true, false]) {
    for (const state of ['future', 'missing', 'invalid', 'past', 'exact'] as const) {
      test(`summary/reset/${id}/${zh ? 'zh' : 'en'}/${state}`, () => {
        const resetsAt = state === 'missing' ? undefined : state === 'invalid' ? 'bad-time'
          : new Date(now + (state === 'future' ? 54 * 3600_000 : state === 'past' ? -1 : 0)).toISOString();
        const quota: LlmSubscriptionQuota = { success: true, windows: [{ id, remainingPercent: 35, resetsAt }] };
        const line = summary(quota, false, zh, now)[0];
        assert.match(line, /35%/);
        if (state === 'future') assert.ok(line.endsWith(zh ? '2天6小时后重置' : 'Resets in 2d 6h'));
        else if (state === 'past' || state === 'exact') assert.match(line, zh ? /已到重置时间，待更新/ : /Reset time reached, awaiting update/);
        else assert.doesNotMatch(line, /重置|Reset/);
      });
    }
  }
}
test('summary/reset/units-and-clock-advance', () => {
  for (const [delta, expected] of [[1, '1分钟'], [28 * 60_000, '28分钟'], [5 * 3600_000, '5小时'], [86400_000, '1天']] as const) {
    const quota: LlmSubscriptionQuota = { success: true, remainingPercent: 35, resetsAt: new Date(now + delta).toISOString() };
    assert.ok(summary(quota, false, true, now)[0].endsWith(`${expected}后重置`));
    assert.match(summary(quota, false, true, now + delta)[0], /已到重置时间/);
  }
});
test('summary/reset/windows-do-not-borrow-top-level-time', () => {
  const quota: LlmSubscriptionQuota = { success: true, resetsAt: new Date(now + 99 * 86400_000).toISOString(), windows: [
    { id: 'session', remainingPercent: 90, resetsAt: new Date(now + 3600_000).toISOString() },
    { id: 'weekly', remainingPercent: 35, resetsAt: new Date(now + 2 * 86400_000).toISOString() },
    { id: 'monthly', remainingPercent: 70 },
  ] };
  const lines = summary(quota, false, true, now);
  assert.match(lines[0], /90% · 1小时后重置/);
  assert.match(lines[1], /35% · 2天后重置/);
  assert.equal(lines[2], '本月剩余可用 70%');
});
test('summary/empty/loading-is-not-zero', () => {
  assert.match(summary(undefined, true, true)[0], /查询中/);
  assert.doesNotMatch(summary(undefined, false, true)[0], /0/);
});
