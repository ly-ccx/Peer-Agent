import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_CONNECTION_RETRY_DELAYS_MS,
  describeConnectionFailure,
  fetchWithConnectionRecovery,
  isRecoverableConnectionFailure,
} from './recovering-fetch.ts';

function connectionError(message: string, code?: string): Error {
  const error = new TypeError(message);
  if (code) {
    (error as Error & { cause?: { code?: string } }).cause = { code };
  }
  return error;
}

describe('CLI recovering fetch', () => {
  test('classifies common network and TLS failures as recoverable', () => {
    expect(isRecoverableConnectionFailure(connectionError('fetch failed', 'ECONNRESET'))).toBe(true);
    expect(isRecoverableConnectionFailure(connectionError('socket hang up'))).toBe(true);
    expect(isRecoverableConnectionFailure(connectionError('connect timeout after 20000ms (ConnectTimeoutError)'))).toBe(true);
    expect(isRecoverableConnectionFailure(connectionError('UNABLE_TO_VERIFY_LEAF_SIGNATURE'))).toBe(true);

    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(isRecoverableConnectionFailure(abort)).toBe(false);
    expect(isRecoverableConnectionFailure(new Error('invalid_api_key'))).toBe(false);
  });

  test('retries a transient connect failure then succeeds', async () => {
    let attempts = 0;
    const waits: number[] = [];
    const response = new Response('ok', { status: 200 });

    const result = await fetchWithConnectionRecovery('https://api.example.test/chat', {
      method: 'POST',
    }, {
      fetchImpl: async () => {
        attempts += 1;
        if (attempts === 1) throw connectionError('fetch failed', 'ECONNRESET');
        return response;
      },
      retryDelaysMs: [25],
      retryJitterRatio: 0,
      waitImpl: async (ms) => {
        waits.push(ms);
      },
      connectTimeoutMs: 0,
    });

    expect(result).toBe(response);
    expect(attempts).toBe(2);
    expect(waits).toEqual([25]);
  });

  test('does not retry non-recoverable failures', async () => {
    let attempts = 0;
    await expect(fetchWithConnectionRecovery('https://api.example.test/chat', undefined, {
      fetchImpl: async () => {
        attempts += 1;
        throw new Error('invalid_api_key');
      },
      retryDelaysMs: [10],
      waitImpl: async () => {},
      connectTimeoutMs: 0,
    })).rejects.toThrow('invalid_api_key');
    expect(attempts).toBe(1);
  });

  test('surfaces the last recoverable failure after exhausting retries', async () => {
    let attempts = 0;
    await expect(fetchWithConnectionRecovery('https://api.example.test/chat', undefined, {
      fetchImpl: async () => {
        attempts += 1;
        throw connectionError('fetch failed', 'ETIMEDOUT');
      },
      retryDelaysMs: DEFAULT_CONNECTION_RETRY_DELAYS_MS,
      retryJitterRatio: 0,
      waitImpl: async () => {},
      connectTimeoutMs: 0,
    })).rejects.toThrow(/fetch failed/);
    expect(attempts).toBe(DEFAULT_CONNECTION_RETRY_DELAYS_MS.length + 1);
  });

  
  test('classifies Bun socket closed and stream interrupted as recoverable', () => {
    expect(isRecoverableConnectionFailure(
      connectionError('The socket connection was closed unexpectedly. For more information, pass verbose: true in the second argument to fetch()'),
    )).toBe(true);
    expect(isRecoverableConnectionFailure(connectionError('Stream interrupted'))).toBe(true);
    expect(isRecoverableConnectionFailure(connectionError('other side closed'))).toBe(true);
    expect(isRecoverableConnectionFailure(connectionError('premature close'))).toBe(true);
  });
test('describes connection failures with optional cause codes', () => {
    expect(describeConnectionFailure(connectionError('fetch failed', 'ECONNRESET')))
      .toBe('fetch failed (ECONNRESET)');
  });
});
