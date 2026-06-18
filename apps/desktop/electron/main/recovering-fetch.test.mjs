import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
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
        maxRetries: 10,
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
});
