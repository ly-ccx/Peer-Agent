import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountUsageTransport } from './account-usage-transport.mjs';

const args = { instanceId: 'one', channelId: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic', allowedOrigins: ['https://api.deepseek.com'], endpoint: 'https://api.deepseek.com/user/balance', apiKey: 'test-only' };
const json = (data) => new Response(JSON.stringify(data));

test('transport/success/cache-hit/expiry/force/credential-rotation/instance-isolation', async () => {
  let calls = 0;
  let time = 0;
  const transport = createAccountUsageTransport({ now: () => time, ttlMs: 10, fetchImpl: async (url, options) => {
    assert.equal(url, args.endpoint);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.match(options.headers.Authorization, /^Bearer /);
    return json({ count: ++calls });
  } });
  const first = await transport.query(args);
  first.data.count = 99;
  assert.equal((await transport.query(args)).data.count, 1);
  time = 11;
  assert.equal((await transport.query(args)).data.count, 2);
  await transport.query({ ...args, force: true });
  await transport.query({ ...args, apiKey: 'rotated' });
  await transport.query({ ...args, instanceId: 'two' });
  assert.equal(calls, 5);
  transport.clear();
  await transport.query(args);
  assert.equal(calls, 6);
});

for (const patch of [
  { baseUrl: 'https://proxy.example' }, { endpoint: 'https://proxy.example/balance' },
  { baseUrl: 'http://api.deepseek.com' }, { baseUrl: 'https://user:password@api.deepseek.com' },
  { baseUrl: 'https://api.deepseek.com.evil.example' },
]) test(`transport/endpoint-isolation/${JSON.stringify(patch)}`, async () => {
  const transport = createAccountUsageTransport({ fetchImpl: () => assert.fail('must not send credential') });
  assert.equal((await transport.query({ ...args, ...patch })).status, 'endpoint_not_supported');
});

test('transport/missing-credential/no-network', async () => {
  const transport = createAccountUsageTransport({ fetchImpl: () => assert.fail('must not fetch') });
  assert.equal((await transport.query({ ...args, apiKey: '' })).status, 'missing_credential');
});

for (const [name, response, status] of [
  ['unauthorized', () => new Response('secret', { status: 401 }), 'auth_required'],
  ['server-error', () => new Response('secret', { status: 500 }), 'fetch_failed'],
  ['redirect-denied', () => new Response('', { status: 302 }), 'redirect_denied'],
  ['malformed', () => new Response('secret'), 'fetch_failed'],
  ['invalid-object', () => json(null), 'invalid_response'],
  ['oversized', () => new Response('a'.repeat(262145)), 'response_too_large'],
]) test(`transport/${name}/not-cached/no-secret`, async () => {
  let calls = 0;
  const transport = createAccountUsageTransport({ fetchImpl: async () => { calls++; return response(); } });
  assert.deepEqual(await transport.query(args), { success: false, status });
  await transport.query(args);
  assert.equal(calls, 2);
});

test('transport/timeout/even-when-fetch-ignores-abort', async () => {
  const transport = createAccountUsageTransport({ timeoutMs: 5, fetchImpl: () => new Promise(() => {}) });
  assert.deepEqual(await transport.query(args), { success: false, status: 'timeout' });
});

test('transport/inflight-deduplication/clear-prevents-stale-repopulation', async () => {
  let release;
  let calls = 0;
  const transport = createAccountUsageTransport({ fetchImpl: async () => { calls++; await new Promise((r) => { release = r; }); return json({}); } });
  const a = transport.query(args);
  const b = transport.query(args);
  assert.equal(calls, 1);
  transport.clear();
  release();
  await Promise.all([a, b]);
  const c = transport.query(args);
  assert.equal(calls, 2);
  release();
  await c;
});
