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
        fromConnection: 'node-fetch',
        toConnection: 'electron-net-fetch',
        reason: 'fetch failed (SELF_SIGNED_CERT_IN_CHAIN)',
      },
    }]);
  });
});
