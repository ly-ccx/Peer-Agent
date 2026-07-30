import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_CONNECTION_RETRY_DELAYS_MS,
  DEFAULT_CONNECT_TIMEOUT_MS,
  fetchWithConnectionRecovery,
  isRecoverableConnectionFailure,
} from './provider-transports/recovering-fetch.mjs';

describe('recovering provider fetch', () => {
  it('classifies corporate TLS and transient transport failures as recoverable', () => {
    assert.equal(isRecoverableConnectionFailure(new TypeError('fetch failed', {
      cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' },
    })), true);
    assert.equal(isRecoverableConnectionFailure(new Error('empty_model_response')), false);
  });

  it('keeps Desktop provider retries on Electron net.fetch without falling back to Node', async () => {
    const events = [];
    let electronCalls = 0;
    let nodeCalls = 0;

    const result = await fetchWithConnectionRecovery('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST',
      body: '{}',
    }, {
      retryDelaysMs: [1],
      waitImpl: async () => {},
      electronFetchImpl: async () => {
        electronCalls += 1;
        if (electronCalls === 1) {
          const error = new TypeError('electron proxy connection reset');
          error.cause = { code: 'ERR_CONNECTION_RESET' };
          throw error;
        }
        return new Response('ok', { status: 200 });
      },
      fetchImpl: async () => {
        nodeCalls += 1;
        const error = new TypeError('fetch failed');
        error.cause = { code: 'SELF_SIGNED_CERT_IN_CHAIN' };
        throw error;
      },
      webContents: {
        send: (channel, payload) => events.push({ channel, payload }),
      },
    });

    assert.equal(result.status, 200);
    assert.equal(electronCalls, 2);
    assert.equal(nodeCalls, 0);
    assert.equal(events.filter((event) => event.payload?.status === 'retrying').length, 1);
    assert.match(events[0].payload.reason, /electron proxy connection reset/);
  });

  it('uses Electron net.fetch immediately without probing Node fetch', async () => {
    const events = [];
    const calls = [];
    let nodeCalls = 0;
    const result = await fetchWithConnectionRecovery('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST',
      body: '{}',
    }, {
      streamId: 's1',
      provider: 'openai-responses',
      model: 'gpt-5.5',
      fetchImpl: async () => {
        nodeCalls += 1;
        throw new Error('Node fetch must not run in Desktop');
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
    assert.equal(nodeCalls, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://chatgpt.com/backend-api/codex/responses');
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(events, []);
  });

  it('fails closed when Electron transport is unavailable in a Desktop runtime', async () => {
    let nodeCalls = 0;

    await assert.rejects(
      fetchWithConnectionRecovery('https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation', {
        method: 'POST',
        body: '{"request_id":"req-1"}',
      }, {
        streamId: 's-electron-required',
        provider: 'qoder',
        model: 'qmodel_latest',
        requireElectronTransport: true,
        fetchImpl: async () => {
          nodeCalls += 1;
          return new Response('wrong transport', { status: 200 });
        },
      }),
      (error) => error?.code === 'electron_net_fetch_unavailable',
    );

    assert.equal(nodeCalls, 0);
  });

  it('emits scheduled retry progress before retrying Electron net.fetch', async () => {
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
      electronFetchImpl: async () => {
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
          connection: 'electron-net-fetch',
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
          connection: 'electron-net-fetch',
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
          connection: 'electron-net-fetch',
          attempt: 2,
          maxRetries: 2,
          reason: 'fetch failed (ETIMEDOUT)',
        },
      },
    ]);
  });

  it('uses one short jittered retry and a 20 second connection timeout by default', async () => {
    const waits = [];
    let attempts = 0;
    await assert.rejects(
      fetchWithConnectionRecovery('https://example.com', {}, {
        electronFetchImpl: async () => {
          attempts += 1;
          const error = new TypeError('fetch failed');
          error.cause = { code: 'ETIMEDOUT' };
          throw error;
        },
        randomImpl: () => 0.5,
        waitImpl: async (ms) => { waits.push(ms); },
      }),
      /fetch failed/,
    );

    assert.equal(attempts, 2);
    assert.deepEqual(DEFAULT_CONNECTION_RETRY_DELAYS_MS, [1_000]);
    assert.deepEqual(waits, [1_250]);
    assert.equal(DEFAULT_CONNECT_TIMEOUT_MS, 20_000);
  });

  it('stops before retrying when the caller cancels during backoff', async () => {
    const controller = new AbortController();
    let attempts = 0;

    await assert.rejects(
      fetchWithConnectionRecovery('https://example.com', { signal: controller.signal }, {
        electronFetchImpl: async () => {
          attempts += 1;
          const error = new TypeError('fetch failed');
          error.cause = { code: 'ETIMEDOUT' };
          throw error;
        },
        retryDelaysMs: [1_000],
        waitImpl: async (_ms, signal) => {
          controller.abort();
          assert.equal(signal.aborted, true);
          throw signal.reason;
        },
      }),
      (error) => error?.name === 'AbortError',
    );

    assert.equal(attempts, 1);
  });

  it('aborts a hung first-call socket via connect-timeout and surfaces a recoverable error into backoff', async () => {
    // Cold start: the first Electron request hangs (socket settles only on
    // abort). The injected scheduleTimeout converts it into a recoverable
    // ConnectTimeoutError. The loop then backs off once and the same Electron
    // transport recovers on round 1.
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

    let timeoutSchedules = 0;
    const result = await fetchWithConnectionRecovery('https://api.example.com/v1/messages', {
      method: 'POST',
      body: '{}',
    }, {
      streamId: 's3',
      provider: 'anthropic',
      model: 'claude',
      retryDelaysMs: [777],
      connectTimeoutMs: 5_000,
      // Fire the connect deadline immediately for the first attempt only.
      scheduleTimeout: (cb) => {
        timeoutSchedules += 1;
        if (timeoutSchedules === 1) cb();
        return () => {};
      },
      waitImpl: async (ms) => { waits.push(ms); },
      electronFetchImpl: async (_url, init) => {
        totalCalls += 1;
        if (totalCalls === 1) return hangUntilAbort(init); // round 0 primary: hang
        return new Response('ok', { status: 200 }); // round 1 primary: recover
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
    assert.equal(recovered[0].payload.connection, 'electron-net-fetch');
  });

  it('rebuilds request init on each connection retry via buildInit', async () => {
    const bodies = [];
    const attempts = [];
    let fetchCalls = 0;

    const result = await fetchWithConnectionRecovery('https://api.example.com/v1/chat', {
      method: 'POST',
      body: 'stale-should-not-be-used',
    }, {
      retryDelaysMs: [1],
      waitImpl: async () => {},
      connectTimeoutMs: 0,
      buildInit: ({ attempt, isRetry }) => {
        attempts.push({ attempt, isRetry });
        return {
          method: 'POST',
          headers: { 'x-attempt': String(attempt) },
          body: JSON.stringify({ request_id: `req-${attempt}`, is_retry: isRetry }),
        };
      },
      electronFetchImpl: async (_url, init) => {
        fetchCalls += 1;
        bodies.push(init.body);
        if (fetchCalls === 1) {
          const error = new TypeError('fetch failed');
          error.cause = { code: 'ETIMEDOUT' };
          throw error;
        }
        return new Response('ok', { status: 200 });
      },
    });

    assert.equal(result.status, 200);
    assert.deepEqual(attempts, [
      { attempt: 0, isRetry: false },
      { attempt: 1, isRetry: true },
    ]);
    assert.deepEqual(bodies, [
      JSON.stringify({ request_id: 'req-0', is_retry: false }),
      JSON.stringify({ request_id: 'req-1', is_retry: true }),
    ]);
  });
});
