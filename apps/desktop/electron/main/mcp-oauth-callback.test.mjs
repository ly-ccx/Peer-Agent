import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createMcpOAuthCallback } from './mcp-oauth-callback.mjs';

function fixture() {
  const server = new EventEmitter(); let handler, closes = 0;
  server.listen = () => {}; server.close = () => { closes++; };
  const callback = createMcpOAuthCallback({ timeoutMs: 60_000, createServer(fn) { handler = fn; return server; } });
  const invoke = url => { const response = { status: null, writeHead(status) { this.status = status; }, end() {} }; handler({ url }, response); return response.status; };
  return { server, callback, invoke, closes: () => closes };
}

test('disposing before listen settles the waiter and closes a later bound socket', async () => {
  const f = fixture(), pending = f.callback.wait('state');
  f.callback.dispose();
  await assert.rejects(pending, /cancelled/);
  f.server.emit('listening');
  assert.equal(f.closes(), 2);
});

test('wrong path is ignored and absent expected state cannot complete OAuth', async () => {
  const f = fixture(), pending = f.callback.wait('state');
  assert.equal(f.invoke('/other?code=secret&state=state'), 404);
  assert.equal(f.closes(), 0);
  assert.equal(f.invoke('/mcp/oauth/callback?code=secret'), 400);
  await assert.rejects(pending, /state mismatch/);
});
