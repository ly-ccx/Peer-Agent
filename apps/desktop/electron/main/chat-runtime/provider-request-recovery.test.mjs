import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { fetchWithConnectionRecovery } from '../provider-transports/recovering-fetch.mjs';
import { sendOpenAIResponsesStreamWithResilience } from '../provider-adapters/openai-responses-adapter.mjs';
import {
  runProviderRequestWithRecovery,
  dispatchProviderRequest,
  observeProviderRequestOutput,
} from './provider-request-recovery.mjs';

const timeout = () => Object.assign(new Error('connect timeout after 20000ms (ConnectTimeoutError)'), { code: 'ConnectTimeoutError' });
const noWait = async () => {};

test('one canonical owner retries throws and returned failures, charging each physical dispatch', async () => {
  const charges = [];
  const history = Array.from({ length: 19 }, (_, i) => ({ role: 'tool', content: `result-${i}` }));
  const fingerprints = [];
  let calls = 0;
  const result = await runProviderRequestWithRecovery(async () => dispatchProviderRequest(async () => {
    fingerprints.push(JSON.stringify(history));
    calls++;
    if (calls === 1) throw timeout();
    if (calls === 2) return { ok: false, status: 503, errorText: 'unavailable' };
    return { ok: true, content: 'done' };
  }), { budgetGuard: { beforeRequest: metadata => charges.push(metadata) }, waitImpl: noWait });
  assert.equal(result.content, 'done');
  assert.equal(calls, 3);
  assert.equal(charges.length, 3);
  assert.ok(charges.every(row => row.accounting === 'physical_dispatch'));
  assert.equal(new Set(fingerprints).size, 1);
  assert.equal(history.length, 19);
});

test('four physical dispatches exhaust one shared recovery allowance', async () => {
  let calls = 0;
  await assert.rejects(runProviderRequestWithRecovery(() => dispatchProviderRequest(async () => {
    calls++;
    throw timeout();
  }), { waitImpl: noWait }), error => error.providerRecovery?.exhausted === true && error.providerRecovery?.attempts === 4);
  assert.equal(calls, 4);
});

test('current partial output prevents silent replay while previous request output does not', async () => {
  observeProviderRequestOutput('chat:stream:delta', { content: 'previous request' });
  let calls = 0;
  await assert.rejects(runProviderRequestWithRecovery(() => dispatchProviderRequest(async () => {
    calls++;
    observeProviderRequestOutput('chat:stream:thinking', { content: 'current thought' });
    throw timeout();
  }), { waitImpl: noWait }), error => error.providerRecovery?.replaySafe === false);
  assert.equal(calls, 1);
});

test('authentication, schema, certificates and cancellation are terminal', async () => {
  for (const failure of [
    { ok: false, status: 401, errorText: 'unauthorized' },
    { ok: false, status: 400, errorText: 'invalid arguments' },
    Object.assign(new Error('CERT_HAS_EXPIRED'), { code: 'CERT_HAS_EXPIRED' }),
    Object.assign(new Error('aborted'), { name: 'AbortError' }),
  ]) {
    let calls = 0;
    const run = runProviderRequestWithRecovery(() => dispatchProviderRequest(async () => {
      calls++;
      if (failure instanceof Error) throw failure;
      return failure;
    }), { waitImpl: noWait });
    if (failure instanceof Error) await assert.rejects(run);
    else assert.equal((await run).ok, false);
    assert.equal(calls, 1);
  }
});

test('structured host failure overrides a transient HTTP diagnostic', async () => {
  let calls = 0;
  const result = await runProviderRequestWithRecovery(() => dispatchProviderRequest(async () => {
    calls++;
    return { ok: false, status: 503, providerRecovery: { kind: 'configuration', retryable: false } };
  }), { waitImpl: noWait });
  assert.equal(calls, 1);
  assert.equal(result.providerRecovery.kind, 'configuration');
  assert.equal(result.providerRecovery.retryable, false);
});

test('budget admission stops the third physical dispatch without invoking fetch', async () => {
  let admissions = 0;
  let calls = 0;
  await assert.rejects(runProviderRequestWithRecovery(() => dispatchProviderRequest(async () => {
    calls++;
    throw timeout();
  }), { waitImpl: noWait, budgetGuard: { beforeRequest() {
    if (admissions >= 2) throw new Error('work_budget_limited');
    admissions++;
  } } }), /work_budget_limited/);
  assert.equal(calls, 2);
  assert.equal(admissions, 2);
});

test('managed transport and Responses retries share four actual loopback HTTP sends', async t => {
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    req.resume();
    res.writeHead(503);
    res.end('synthetic transient failure');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const charges = [];
  const usage = [];
  const result = await runProviderRequestWithRecovery(() => sendOpenAIResponsesStreamWithResilience(async () => {
    const response = await fetchWithConnectionRecovery(`http://127.0.0.1:${server.address().port}`, {
      method: 'POST', body: JSON.stringify({ model: 'fixture', messages: [{ role: 'user', content: 'fixture' }] }),
    }, { requireElectronTransport: false, connectTimeoutMs: 0, retryDelaysMs: [0, 0, 0] });
    return { ok: response.ok, status: response.status, errorText: await response.text() };
  }, { transientRetryDelaysMs: [0, 0, 0] }), {
    waitImpl: noWait,
    budgetGuard: { beforeRequest: metadata => charges.push(metadata), observeUsage: value => usage.push(value) },
  });
  assert.equal(requests, 4);
  assert.equal(charges.length, 4);
  assert.equal(usage.length, 4);
  assert.ok(usage.every(value => value === null));
  assert.equal(result.providerRecovery.exhausted, true);
  assert.equal(result.providerRecovery.kind, 'provider_transient');
});

test('Grok model version resend is charged while release metadata GET is excluded', async () => {
  let metadataCalls = 0;
  let modelCalls = 0;
  const charges = [];
  const usage = [];
  const response = await runProviderRequestWithRecovery(() => fetchWithConnectionRecovery(
    'https://cli-chat-proxy.grok.com/v1/responses', {
      method: 'POST', headers: { 'X-XAI-Token-Auth': 'xai-grok-cli', 'x-grok-client-surface': 'grok-build' },
      body: '{}',
    }, { requireElectronTransport: false, connectTimeoutMs: 0, fetchImpl: async url => {
      if (url === 'https://x.ai/cli/stable') {
        metadataCalls++;
        return new Response(metadataCalls === 1 ? '1.0.1' : '1.0.2');
      }
      modelCalls++;
      return new Response('fixture', { status: modelCalls === 1 ? 426 : 200 });
    } }), { waitImpl: noWait,
    budgetGuard: { beforeRequest: metadata => charges.push(metadata), observeUsage: value => usage.push(value) },
  });
  assert.equal(response.status, 200);
  assert.equal(metadataCalls, 2);
  assert.equal(modelCalls, 2);
  assert.equal(charges.length, 2);
  assert.equal(usage.length, 2);
  assert.ok(usage.every(value => value === null));
});

test('real usage is normalized once and failed attempts retain unknown separately', async () => {
  const observations = [];
  let calls = 0;
  await runProviderRequestWithRecovery(() => dispatchProviderRequest(async () => {
    if (++calls === 1) throw timeout();
    return { ok: true, streamUsage: { inputTokens: 7, outputTokens: 2, cacheReadTokens: 3 } };
  }), { waitImpl: noWait, budgetGuard: { beforeRequest() {}, observeUsage: (value, key) => observations.push({ value, key }) } });
  assert.equal(observations.length, 2);
  assert.equal(observations[0].value, null);
  assert.equal(observations[1].value.totalTokens, 12);
  assert.notEqual(observations[0].key, observations[1].key);
});

test('a socket failure after response headers is classified as stream interruption', async () => {
  let calls = 0;
  const progress = [];
  await runProviderRequestWithRecovery(async () => {
    await dispatchProviderRequest(async () => new Response('fixture'));
    if (++calls === 1) throw Object.assign(new Error('socket closed'), { code: 'ECONNRESET' });
    return { ok: true };
  }, { waitImpl: noWait, webContents: { send: (channel, payload) => progress.push({ channel, payload }) } });
  const retry = progress.find(event => event.payload.status === 'retrying');
  assert.equal(retry.payload.providerRecovery.kind, 'stream_interrupted');
  assert.equal(retry.payload.providerRecovery.phase, 'stream');
  assert.equal(calls, 2);
});

test('cancellation during recovery backoff stops further model dispatch', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(runProviderRequestWithRecovery(() => dispatchProviderRequest(async () => {
    calls++;
    throw timeout();
  }), { signal: controller.signal, waitImpl: async () => {
    controller.abort();
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  } }), error => error.name === 'AbortError');
  assert.equal(calls, 1);
});
