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
test('summary/empty/loading-is-not-zero', () => {
  assert.match(summary(undefined, true, true)[0], /查询中/);
  assert.doesNotMatch(summary(undefined, false, true)[0], /0/);
});
