import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGlmUsage } from './account-usage-glm.mjs';
import { createAccountUsageAdapters } from './account-usage-adapters.mjs';
const payload = { success: true, code: 200, data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 10, usage: 100, currentValue: 25, remaining: 70 }] } };
for (const [region, origin, other] of [['cn', 'https://open.bigmodel.cn', 'https://api.z.ai'], ['global', 'https://api.z.ai', 'https://open.bigmodel.cn']]) {
  const provider = { id: 'one', channelId: `glm-coding-plan-${region}`, authMethod: 'api_key', baseUrl: `${origin}/api/anthropic` };
  for (const state of ['success', 'missing', 'failure', 'cross-region', 'cache']) test(`glm/${region}/${state}`, async () => {
    let calls = 0;
    const adapters = createAccountUsageAdapters({ fetchImpl: async (url) => { calls++; assert.equal(url, `${origin}/api/monitor/usage/quota/limit`); return new Response(JSON.stringify(payload), { status: state === 'failure' ? 403 : 200 }); } });
    const result = await adapters.fetch(state === 'cross-region' ? { ...provider, baseUrl: other } : provider, { apiKey: state === 'missing' ? '' : 'test-only' });
    if (state === 'cross-region' || state === 'missing') { assert.equal(calls, 0); assert.equal(result.success, false); }
    else if (state === 'failure') assert.equal(result.status, 'auth_required');
    else { assert.equal(result.success, true); assert.equal(result.windows[0].usedPercent, 30); }
    if (state === 'cache') { await adapters.fetch(provider, { apiKey: 'test-only' }); assert.equal(calls, 1); await adapters.fetch(provider, { apiKey: 'rotated' }); assert.equal(calls, 2); }
  });
}
test('glm/invalid-envelope/missing-percentage/unknown-type/not-zero', () => {
  for (const p of [{}, { ...payload, success: false }, { ...payload, code: 500 }, { success: true, code: 200, data: { limits: [{ type: 'TOKENS_LIMIT' }, null] } }]) assert.equal(parseGlmUsage(p).success, false);
});
test('glm/credit/mcp/reset-plausibility/zero', () => {
  const now = Date.parse('2026-09-05T00:00:00Z');
  const limits = [
    { type: 'CREDIT_LIMIT', unit: 3, number: 5, percentage: 0, nextResetTime: now + 3600000 },
    { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 20, nextResetTime: now + 86400000 },
    { type: 'TIME_LIMIT', unit: 1, number: 30, percentage: 50, nextResetTime: now + 86400000 },
  ];
  const r = parseGlmUsage({ success: true, code: 200, data: { limits } }, now);
  assert.equal(r.windows.length, 3);
  assert.equal(r.windows[0].usedPercent, 0);
  assert.equal(r.windows[0].resetsAt, '2026-09-05T01:00:00.000Z');
  assert.equal(r.windows[1].resetsAt, undefined);
  assert.equal(r.windows[2].label, 'MCP 额度');
  assert.equal(r.windows[2].resetsAt, '2026-09-06T00:00:00.000Z');
});
