import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountUsageAdapters } from './account-usage-adapters.mjs';
import { parseMiniMaxUsage } from './account-usage-minimax.mjs';
import { parseBailianUsage } from './account-usage-bailian.mjs';
import { createAccountUsageTransport } from './account-usage-transport.mjs';

const now = 1780000000000;
const counts = { model_name: 'MiniMax-M2', current_interval_total_count: 100, current_interval_usage_count: 75, end_time: now + 60000, current_weekly_total_count: 1000, current_weekly_usage_count: 600, weekly_end_time: now + 86400000 };
const mini = { base_resp: { status_code: 0 }, model_remains: [counts] };
const quota = { per5HourUsedQuota: 20, per5HourTotalQuota: 100, per5HourQuotaNextRefreshTime: now + 60000, perWeekUsedQuota: 200, perWeekTotalQuota: 1000, perBillMonthUsedQuota: 400, perBillMonthTotalQuota: 2000 };
const ali = { status_code: 0, data: { codingPlanQuotaInfo: quota } };

// MiniMax representation × nesting × interval/week. Each cell asserts remaining semantics.
for (const camel of [false, true]) for (const nested of [false, true]) for (const percents of [false, true]) test(`minimax/${camel ? 'camel' : 'snake'}/${nested ? 'nested' : 'root'}/${percents ? 'percent' : 'counts'}/interval-and-week`, () => {
  let row = { ...counts, ...(percents ? { current_interval_remaining_percent: 45, current_weekly_remaining_percent: 80 } : {}) };
  if (camel) row = Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), value]));
  const payload = { [camel ? 'modelRemains' : 'model_remains']: [row] };
  const result = parseMiniMaxUsage(nested ? { data: payload } : payload, now);
  assert.equal(result.success, true);
  assert.equal(result.windows.length, 2);
  assert.deepEqual(result.windows.map((w) => w.usedPercent), percents ? [55, 20] : [25, 40]);
  assert.deepEqual(result.windows.map((w) => w.used), percents ? [undefined, undefined] : [25, 400]);
  assert.equal(result.windows[0].resetsAt, new Date(now + 60000).toISOString());
  assert.equal(result.windows[1].resetsAt, new Date(now + 86400000).toISOString());
});
test('minimax/unlimited-placeholder-and-missing-not-finite-zero', () => {
  const result = parseMiniMaxUsage({ model_remains: [{ model_name: 'General', current_weekly_status: 3, current_weekly_remaining_percent: 100 }, { model_name: 'Speech', current_interval_status: 3, current_interval_remaining_percent: 100 }] });
  assert.equal(result.success, true);
  assert.equal(result.windows.length, 0);
  assert.ok(result.unavailable.some((row) => /不限量/.test(row.reason)));
  assert.equal(parseMiniMaxUsage({ model_remains: [{}] }).success, false);
  assert.equal(parseMiniMaxUsage({ ...mini, base_resp: { status_code: 1004, status_msg: 'secret' } }).success, false);
});
test('minimax/relative-reset-ms-and-services', () => {
  const result = parseMiniMaxUsage({ model_remains: [{ ...counts, end_time: undefined, remains_time: 1000, weekly_end_time: undefined, weekly_remains_time: 2000 }] }, now);
  assert.deepEqual(result.windows.map((w) => w.resetsAt), [new Date(now + 1000).toISOString(), new Date(now + 2000).toISOString()]);
  assert.equal(parseMiniMaxUsage({ services: [{ service_type: 'Text', window_type: 'daily', usage: 2, limit: 10 }] }).windows[0].used, 2);
});
for (const [channelId, origin, wrong] of [['minimax-cn', 'https://api.minimaxi.com', 'https://api.minimax.io'], ['minimax-global', 'https://api.minimax.io', 'https://api.minimaxi.com']]) {
  for (const fallback of [false, true]) test(`${channelId}/token-first/coding-fallback-${fallback}/no-regional-retry`, async () => {
    const urls = [];
    const adapters = createAccountUsageAdapters({ now: () => now, fetchImpl: async (url) => {
      urls.push(url);
      return new Response(JSON.stringify(mini), { status: fallback && url.endsWith('/token_plan/remains') ? 404 : 200 });
    } });
    const provider = { id: 'mini', channelId, baseUrl: origin + '/anthropic', authMethod: 'api_key' };
    assert.equal((await adapters.fetch(provider, { apiKey: 'secret' })).success, true);
    assert.deepEqual(urls, [origin + '/v1/token_plan/remains', ...(fallback ? [origin + '/v1/api/openplatform/coding_plan/remains'] : [])]);
    assert.equal((await adapters.fetch({ ...provider, baseUrl: wrong + '/anthropic' }, { apiKey: 'secret' })).status, 'endpoint_not_supported');
    assert.equal(urls.length, fallback ? 2 : 1);
  });
}

test('bailian/multi-window-and-ms-reset', () => {
  const result = parseBailianUsage(ali, now);
  assert.deepEqual(result.windows.map((w) => [w.id, w.used, w.limit]), [['five-hour', 20, 100], ['week', 200, 1000], ['month', 400, 2000]]);
  assert.equal(result.windows[0].resetsAt, new Date(now + 60000).toISOString());
});
for (const nested of [false, true]) test(`bailian/active-not-expired/nested-${nested}`, () => {
  const infos = [{ status: 'EXPIRED', codingPlanQuotaInfo: { ...quota, per5HourUsedQuota: 99 } }, { status: 'ACTIVE', ...(nested ? { codingPlanQuotaInfo: quota } : {}) }];
  const result = parseBailianUsage({ data: { codingPlanInstanceInfos: infos, ...(!nested ? { codingPlanQuotaInfo: quota } : {}) } }, now);
  assert.equal(result.windows[0].used, 20);
});
test('bailian/no-guess-expired-tied-missing-error', () => {
  for (const payload of [{ data: { codingPlanInstanceInfos: [{ status: 'EXPIRED', codingPlanQuotaInfo: quota }] } }, { data: { codingPlanInstanceInfos: [{ codingPlanQuotaInfo: quota }, { codingPlanQuotaInfo: quota }] } }, { status_code: 403, data: { codingPlanQuotaInfo: quota } }, { data: { codingPlanQuotaInfo: { per5HourTotalQuota: 100 } } }]) assert.equal(parseBailianUsage(payload, now).success, false);
  assert.equal(parseBailianUsage({ data: { codingPlanQuotaInfo: { per5HourTotalQuota: 0, per5HourUsedQuota: 0 } } }).windows[0].used, 0);
});
test('bailian/fixed-cn-read-only-post/credential-and-region-boundaries', async () => {
  let calls = 0;
  const adapters = createAccountUsageAdapters({ fetchImpl: async (url, opts) => {
    calls++;
    const target = new URL(url);
    assert.equal(target.origin, 'https://bailian.console.aliyun.com');
    assert.equal(target.searchParams.get('api'), 'queryCodingPlanInstanceInfoV2');
    assert.equal(target.searchParams.get('currentRegionId'), 'cn-beijing');
    assert.equal(opts.method, 'POST');
    assert.equal(opts.redirect, 'error');
    assert.equal(opts.headers['X-DashScope-API-Key'], 'secret');
    assert.equal(opts.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(opts.body), { queryCodingPlanInstanceInfoRequest: { commodityCode: 'sfm_codingplan_public_cn' } });
    return new Response(JSON.stringify(ali));
  } });
  const provider = { id: 'ali', channelId: 'aliyun-bailian', baseUrl: 'https://coding.dashscope.aliyuncs.com/v1', authMethod: 'api_key' };
  assert.equal((await adapters.fetch(provider, { apiKey: 'secret' })).success, true);
  for (const baseUrl of ['https://coding-intl.dashscope.aliyuncs.com/v1', 'https://evil.test/v1', 'https://bailian.console.aliyun.com/v1']) assert.equal((await adapters.fetch({ ...provider, baseUrl }, { apiKey: 'secret' })).status, 'endpoint_not_supported');
  assert.equal(calls, 1);
});
test('transport/post-get-body-auth-headers-cache-isolation', async () => {
  let calls = 0;
  const transport = createAccountUsageTransport({ fetchImpl: async () => { calls++; return new Response('{}'); } });
  const base = { instanceId: 'x', channelId: 'x', baseUrl: 'https://model.test', allowedOrigins: ['https://model.test'], allowedEndpointOrigins: ['https://account.test'], endpoint: 'https://account.test/query', apiKey: 'secret' };
  for (const variant of [{}, { method: 'POST', body: '{}' }, { method: 'POST', body: '{"region":"cn"}' }, { method: 'POST', body: '{}', apiKeyHeaders: ['x-api-key'] }]) {
    assert.equal((await transport.query({ ...base, ...variant })).success, true);
    assert.equal((await transport.query({ ...base, ...variant })).success, true);
  }
  assert.equal(calls, 4);
  for (const variant of [{ method: 'DELETE' }, { body: '{}' }, { method: 'POST', body: 'x'.repeat(4097) }, { headers: { Authorization: 'other' } }, { apiKeyHeaders: ['Cookie'] }, { endpoint: 'https://model.test/query' }]) assert.equal((await transport.query({ ...base, ...variant })).status, 'endpoint_not_supported');
  assert.equal(calls, 4);
});
