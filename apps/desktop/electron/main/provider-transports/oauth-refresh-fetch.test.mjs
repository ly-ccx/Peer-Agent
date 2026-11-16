import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { createOAuthRefreshFetch } from './oauth-refresh-fetch.mjs';
import { fetchWithConnectionRecovery } from './recovering-fetch.mjs';

test('refresh preserves host policy and caller cancellation while disabling redirects/replay', async () => {
  const caller = new AbortController(); let captured;
  const request = createOAuthRefreshFetch(async (...args) => { captured = args; return new Response('{}'); });
  await request('https://token.example', { signal: caller.signal, method: 'POST' });
  assert.equal(captured[1].redirect, 'error');
  assert.deepEqual(captured[2].retryDelaysMs, []);
  assert.equal(captured[1].signal.aborted, false);
  caller.abort(); assert.equal(captured[1].signal.aborted, true);
});

test('lost real HTTP response never causes another refresh POST through host recovery', async () => {
  let requests = 0;
  const server = createServer(async (request) => {
    for await (const _chunk of request) { /* consume refresh request */ }
    requests++; request.socket.destroy();
  });
  try {
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${server.address().port}/token`;
    const refresh = createOAuthRefreshFetch((input, init, options) => fetchWithConnectionRecovery(input, init, {
      ...options, fetchImpl: globalThis.fetch, requireElectronTransport: false,
    }));
    await assert.rejects(refresh(url, { method: 'POST', body: 'synthetic-refresh' }));
    assert.equal(requests, 1);
  } finally {
    server.closeAllConnections(); await new Promise(done => server.close(done));
  }
});
