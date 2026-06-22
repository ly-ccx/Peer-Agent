import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_CONNECTION_RETRY_DELAYS_MS,
  DEFAULT_CONNECT_TIMEOUT_MS,
  fetchWithConnectionRecovery,
  isRecoverableConnectionFailure,
} from './provider-transports/recovering-fetch.mjs';

describe('recovering provider fetch', () => {
  it('classifies corporate TLS and Node fetch failures as connection recoverable', () => {
    assert.equal(isRecoverableConnectionFailure(new TypeError('fetch failed', {
      cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' },
    })), true);
    assert.equal(isRecoverableConnectionFailure(new Error('empty_model_response')), false);
  });

  it('falls back from Node fetch to Electron net.fetch without changing provider or model', async () => {
    const events = [];
    const calls = [];
    const result = await fetchWithConnectionRecovery('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST',
      body: '{}',
    }, {
      streamId: 's1',
      provider: 'openai-responses',
      model: 'gpt-5.5',
      fetchImpl: async () => {
        const error = new TypeError('fetch failed');
        error.cause = { code: 'SELF_SIGNED_CERT_IN_CHAIN' };
        throw error;
      },
      electronFetchImpl: async (url, init) => {
        calls.push({ url, init });
        return new Response('ok', { status: 200 });
      },
      webContents: {
        send: (channel, payload) => events.push({ channel, payload }),
      },
    });

    assert.equal(result.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://chatgpt.com/backend-api/codex/responses');
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(events, [{
      channel: 'chat:stream:connection-recovery',
      payload: {
        streamId: 's1',
        provider: 'openai-responses',
        model: 'gpt-5.5',
        status: 'recovered',
        fromConnection: 'node-fetch',
        toConnection: 'electron-net-fetch',
        connection: 'electron-net-fetch',
        attempt: 0,
        maxRetries: 4,
        reason: 'fetch failed (SELF_SIGNED_CERT_IN_CHAIN)',
      },
    }]);
  });

  it('emits scheduled retry progress before retrying Node fetch', async () => {
    const events = [];
    const waits = [];
    let attempts = 0;

    const result = await fetchWithConnectionRecovery('https://api.openai.example/chat/completions', {
      method: 'POST',
      body: '{}',
    }, {
      streamId: 's2',
      provider: 'openai',
      model: 'gpt-5.5',
      retryDelaysMs: [10_000, 30_000],
      waitImpl: async (ms) => waits.push(ms),
      fetchImpl: async () => {
        attempts += 1;
        if (attempts < 3) {
          const error = new TypeError('fetch failed');
          error.cause = { code: 'ETIMEDOUT' };
          throw error;
        }
        return new Response('ok', { status: 200 });
      },
      webContents: {
        send: (channel, payload) => events.push({ channel, payload }),
      },
    });

    assert.equal(result.status, 200);
    assert.deepEqual(waits, [10_000, 30_000]);
    assert.deepEqual(events, [
      {
        channel: 'chat:stream:connection-recovery',
        payload: {
          streamId: 's2',
          provider: 'openai',
          model: 'gpt-5.5',
          status: 'retrying',
          attempt: 1,
          maxRetries: 2,
          delayMs: 10_000,
          reason: 'fetch failed (ETIMEDOUT)',
        },
      },
      {
        channel: 'chat:stream:connection-recovery',
        payload: {
          streamId: 's2',
          provider: 'openai',
          model: 'gpt-5.5',
          status: 'retrying',
          attempt: 2,
          maxRetries: 2,
          delayMs: 30_000,
          reason: 'fetch failed (ETIMEDOUT)',
        },
      },
      {
        channel: 'chat:stream:connection-recovery',
        payload: {
          streamId: 's2',
          provider: 'openai',
          model: 'gpt-5.5',
          status: 'recovered',
          connection: 'node-fetch',
          attempt: 2,
          maxRetries: 2,
          reason: 'fetch failed (ETIMEDOUT)',
        },
      },
    ]);
  });

  it('uses a fast-first bounded default backoff (no flat 25s), avoiding double-layer wait', () => {
    // Guards the t2 convergence: the transport default must not be the old
    // flat 5s x 5. Fast first retry + bounded total keeps cold-start blips snappy.
    assert.deepEqual(DEFAULT_CONNECTION_RETRY_DELAYS_MS, [500, 1_500, 3_000, 5_000]);
    const total = DEFAULT_CONNECTION_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    assert.ok(total <= 10_000, `expected bounded total <=10s, got ${total}`);
    assert.equal(DEFAULT_CONNECTION_RETRY_DELAYS_MS[0], 500, 'first retry should be fast');
    assert.ok(DEFAULT_CONNECT_TIMEOUT_MS > 0 && DEFAULT_CONNECT_TIMEOUT_MS <= 15_000);
  });

  it('aborts a hung first-call socket via connect-timeout and surfaces a recoverable error into backoff', async () => {
    // Cold start: in round 0 both channels hang (socket settles only on abort).
    // The injected scheduleTimeout fires the connect deadline for those first
    // two attempts, converting each hang into a recoverable ConnectTimeoutError.
    // The loop then backs off once and round 1 recovers — proving a hung first
    // call no longer blocks the turn forever.
    const events = [];
    const waits = [];
    let totalCalls = 0;

    // A socket that never returns headers and only rejects when its signal aborts.
    const hangUntilAbort = (init) => new Promise((_resolve, reject) => {
      const sig = init?.signal;
      const onAbort = () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      };
      if (sig?.aborted) { onAbort(); return; }
      sig?.addEventListener('abort', onAbort, { once: true });
    });

    const result = await fetchWithConnectionRecovery('https://api.example.com/v1/messages', {
      method: 'POST',
      body: '{}',
    }, {
      streamId: 's3',
      provider: 'anthropic',
      model: 'claude',
      // Force "no proxy" so node-fetch (fetchImpl) is the primary channel.
      detectProxy: async () => false,
      retryDelaysMs: [777],
      connectTimeoutMs: 5_000,
      // Fire the connect deadline immediately for the two round-0 attempts only.
      scheduleTimeout: (cb) => {
        if (totalCalls <= 2) cb();
        return () => {};
      },
      waitImpl: async (ms) => { waits.push(ms); },
      fetchImpl: async (_url, init) => {
        totalCalls += 1;
        if (totalCalls === 1) return hangUntilAbort(init); // round 0 primary: hang
        return new Response('ok', { status: 200 }); // round 1 primary: recover
      },
      electronFetchImpl: async (_url, init) => {
        totalCalls += 1;
        return hangUntilAbort(init); // round 0 secondary: hang -> connect-timeout
      },
      webContents: {
        send: (channel, payload) => events.push({ channel, payload }),
      },
    });

    assert.equal(result.status, 200);
    // The connect-timeout converted the hang into a bounded failure that entered
    // the backoff (one scheduled wait), instead of blocking forever.
    assert.deepEqual(waits, [777]);
    const retrying = events.filter((e) => e.payload?.status === 'retrying');
    assert.equal(retrying.length, 1);
    assert.match(retrying[0].payload.reason, /ConnectTimeoutError/);
    // Round 1 recovered on the primary channel.
    const recovered = events.filter((e) => e.payload?.status === 'recovered');
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].payload.connection, 'node-fetch');
  });
});
