import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import {
  GROK_STABLE_RELEASE_URL, GROK_SUBSCRIPTION_BASE_URL,
  buildGrokSubscriptionHeaders, createGrokSubscriptionTransport,
  formatGrokSubscriptionHttpError,
} from './grok-subscription-transport.mjs';

const target = `${GROK_SUBSCRIPTION_BASE_URL}/responses`;
const request = () => ({ method: 'POST', headers: buildGrokSubscriptionHeaders('fixture-token'), body: '{"model":"grok-4.6"}' });

test('discovers once for concurrent catalog and chat; keeps credentials off metadata and preserves requests', async () => {
  const transport = createGrokSubscriptionTransport();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url === GROK_STABLE_RELEASE_URL) { await delay(5); return new Response('1.0.46\n'); }
    return new Response('ok');
  };
  const init = request();
  await Promise.all([transport.fetch(fetchImpl, target, init), transport.fetch(fetchImpl, `${GROK_SUBSCRIPTION_BASE_URL}/models`, init)]);
  await transport.fetch(fetchImpl, target, init);
  assert.equal(calls.filter(c => c.url === GROK_STABLE_RELEASE_URL).length, 1);
  const metadata = calls[0].init;
  assert.equal(new Headers(metadata.headers).has('authorization'), false);
  assert.equal(metadata.body, undefined);
  assert.equal(metadata.redirect, 'error');
  for (const { init: sent } of calls.slice(1)) {
    assert.equal(sent.headers.get('x-grok-client-version'), '1.0.46');
    assert.equal(sent.headers.get('authorization'), 'Bearer fixture-token');
    assert.equal(sent.method, init.method);
    assert.equal(sent.body, init.body);
  }
  assert.equal(init.headers['x-grok-client-version'], undefined);
});

test('426 refreshes the official feed and retries once with its changed version', async () => {
  const transport = createGrokSubscriptionTransport();
  let metadata = 0; const versions = [];
  const fetchImpl = async (url, init) => {
    if (url === GROK_STABLE_RELEASE_URL) return new Response(++metadata === 1 ? '1.0.46' : '1.0.47');
    versions.push(init.headers.get('x-grok-client-version'));
    // An upstream error number must never become our compatibility identity.
    return versions.length === 1 ? new Response('Please update to version 9.9.9', { status: 426 }) : new Response('ok');
  };
  assert.equal((await transport.fetch(fetchImpl, target, request())).status, 200);
  assert.deepEqual(versions, ['1.0.46', '1.0.47']);
});

test('same official release or another 426 never loops', async () => {
  for (const changed of [false, true]) {
    const transport = createGrokSubscriptionTransport();
    let metadata = 0; let requests = 0;
    const result = await transport.fetch(async url => {
      if (url === GROK_STABLE_RELEASE_URL) return new Response(++metadata > 1 && changed ? '1.0.47' : '1.0.46');
      requests++; return new Response('upgrade', { status: 426 });
    }, target, request());
    assert.equal(result.status, 426);
    assert.equal(requests, changed ? 2 : 1);
    assert.equal(metadata, 2);
  }
});

test('other providers and API-key requests never discover or modify compatibility', async () => {
  const transport = createGrokSubscriptionTransport();
  for (const [url, init] of [['https://api.x.ai/v1/responses', request()], [target, { headers: { Authorization: 'Bearer api-key' } }]]) {
    let calls = 0;
    await transport.fetch(async (actual, options) => {
      calls++; assert.equal(actual, url); assert.equal(options, init); return new Response('ok');
    }, url, init);
    assert.equal(calls, 1);
  }
});

test('invalid or unsupported major metadata fails before inference', async () => {
  for (const release of ['invalid', '1.0.46-beta', '2.0.0']) {
    const transport = createGrokSubscriptionTransport();
    let inference = 0;
    await assert.rejects(transport.fetch(async url => {
      if (url !== GROK_STABLE_RELEASE_URL) inference++;
      return new Response(release);
    }, target, request()), error => ['grok_compatibility_unavailable', 'grok_subscription_upgrade_required'].includes(error.code));
    assert.equal(inference, 0);
  }
});

test('metadata timeout is bounded and leaves the next request able to retry', async () => {
  const transport = createGrokSubscriptionTransport({ metadataTimeoutMs: 10 });
  await assert.rejects(transport.fetch(async (url, init) => {
    await delay(50, undefined, { signal: init.signal });
    return new Response('1.0.46');
  }, target, request()), { code: 'grok_compatibility_unavailable' });
  assert.equal((await transport.fetch(async url => new Response(url === GROK_STABLE_RELEASE_URL ? '1.0.46' : 'ok'), target, request())).status, 200);
});

test('already cancelled requests do not start discovery', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createGrokSubscriptionTransport().fetch(() => { throw new Error('must not fetch'); }, target, { ...request(), signal: controller.signal }), { name: 'AbortError' });
});

test('one caller cancelling discovery does not cancel another caller sharing it', async () => {
  const transport = createGrokSubscriptionTransport();
  const controller = new AbortController(); let metadata = 0; let inference = 0;
  const fetchImpl = async url => {
    if (url === GROK_STABLE_RELEASE_URL) { metadata++; await delay(20); return new Response('1.0.46'); }
    inference++; return new Response('ok');
  };
  const cancelled = transport.fetch(fetchImpl, target, { ...request(), signal: controller.signal });
  const active = transport.fetch(fetchImpl, target, request());
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  await active;
  assert.equal(metadata, 1); assert.equal(inference, 1);
});

test('known release has bounded offline grace; a rejected release loses that grace', async () => {
  let at = 0; let offline = false; let rejected = false;
  const transport = createGrokSubscriptionTransport({ now: () => at, cacheTtlMs: 10, maxStaleMs: 30 });
  const fetchImpl = async url => {
    if (url === GROK_STABLE_RELEASE_URL) {
      if (offline) throw new Error('offline');
      return new Response('1.0.46');
    }
    return new Response('reply', { status: rejected ? 426 : 200 });
  };
  await transport.fetch(fetchImpl, target, request());
  at = 15; offline = true;
  assert.equal((await transport.fetch(fetchImpl, target, request())).status, 200);
  rejected = true;
  assert.equal((await transport.fetch(fetchImpl, target, request())).status, 426);
  await assert.rejects(transport.fetch(fetchImpl, target, request()), { code: 'grok_compatibility_unavailable' });
  const expired = createGrokSubscriptionTransport({ now: () => at, cacheTtlMs: 10, maxStaleMs: 30 });
  offline = false; rejected = false; await expired.fetch(fetchImpl, target, request());
  at = 50; offline = true;
  await assert.rejects(expired.fetch(fetchImpl, target, request()), { code: 'grok_compatibility_unavailable' });
});

test('Request objects preserve subscription headers without changing the original', async () => {
  const input = new Request(target, request());
  let sent;
  await createGrokSubscriptionTransport().fetch(async (url, init) => {
    if (url === GROK_STABLE_RELEASE_URL) return new Response('1.0.46');
    sent = init.headers; assert.equal(url, input); return new Response('ok');
  }, input);
  assert.equal(sent.get('authorization'), input.headers.get('authorization'));
  assert.equal(sent.get('x-grok-client-version'), '1.0.46');
  assert.equal(input.headers.has('x-grok-client-version'), false);
});

test('Grok upgrade errors explain Peer compatibility; unrelated errors keep their content', () => {
  const raw = 'Your Grok CLI version is outdated. Please update to version 1.0.13 or later via `grok update`';
  const readable = formatGrokSubscriptionHttpError(426, raw, request().headers);
  assert.match(readable, /Peer Agent.*1\.0\.13/);
  assert.doesNotMatch(readable, /grok update/);
  assert.equal(formatGrokSubscriptionHttpError(400, raw, request().headers), raw);
  assert.equal(formatGrokSubscriptionHttpError(426, raw, {}), raw);
});
