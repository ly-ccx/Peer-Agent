import http from 'node:http';

/** Own one loopback callback and its timeout; disposal settles the waiter as well as the socket. */
export function createMcpOAuthCallback({ port = 33418, callbackPath = '/mcp/oauth/callback', timeoutMs = 300_000,
  createServer = handler => http.createServer(handler) } = {}) {
  const url = `http://127.0.0.1:${port}${callbackPath}`;
  let active = null;
  function finish(record, error, code) {
    if (record.settled) return;
    record.settled = true;
    clearTimeout(record.timer);
    if (active === record) active = null;
    try { record.server.close(); } catch { /* A failed bind has no listening handle. */ }
    if (error) record.reject(error); else record.resolve(code);
  }
  function dispose() {
    if (active) finish(active, new Error('mcp_oauth_callback_cancelled'));
  }
  function wait(expectedState) {
    dispose();
    return new Promise((resolve, reject) => {
      const record = { resolve, reject, settled: false, timer: null, server: null };
      record.server = createServer((request, response) => {
        try {
          const callback = new URL(request.url ?? '/', url);
          if (callback.pathname !== callbackPath) {
            response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); response.end('Not found'); return;
          }
          const state = callback.searchParams.get('state') ?? '';
          if (expectedState && state !== expectedState) throw new Error('MCP OAuth state mismatch.');
          const error = callback.searchParams.get('error');
          if (error) throw new Error(`MCP OAuth failed: ${error}`);
          const code = callback.searchParams.get('code');
          if (!code) throw new Error('MCP OAuth callback missing authorization code.');
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          response.end('<!doctype html><meta charset="utf-8"><title>Peer Agent MCP OAuth</title><p>授权已完成，可以回到 Peer Agent。</p>');
          finish(record, null, code);
        } catch (error) {
          response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
          response.end('<!doctype html><meta charset="utf-8"><title>Peer Agent MCP OAuth</title><p>授权失败，请回到 Peer Agent 重试。</p>');
          finish(record, error);
        }
      });
      active = record;
      record.server.once('listening', () => { if (record.settled) record.server.close(); });
      record.server.once('error', error => finish(record, error));
      record.timer = setTimeout(() => finish(record, new Error('MCP OAuth authorization timed out.')), timeoutMs);
      record.server.listen(port, '127.0.0.1');
    });
  }
  return { url, wait, dispose };
}
