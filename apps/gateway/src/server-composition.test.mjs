import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { request } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { WebSocket } from 'ws';
import { createDeviceStore } from './device-store.mjs';
import { createGatewayHttpServer } from './http-server.mjs';

test('composed listener serves HTTP and authenticated device WS; shutdown closes upgraded sockets', { timeout: 5000 }, async t => {
  const store = createDeviceStore(':memory:');
  const keys = generateKeyPairSync('ed25519');
  const p = store.beginPairing({ name: 'Mac', publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() });
  store.claimPairing('owner', p.challengeId, p.pairingKey);
  store.acknowledgeBinding({ deviceId: p.deviceId, ownerId: 'owner', bindingVersion: 1 });
  const server = createGatewayHttpServer({ origin: 'https://peer.example', deviceStore: store,
    handle: async () => Response.json({ ok: true }) });
  const address = await server.listen();
  let closed = false;
  t.after(async () => { if (!closed) await server.close(); store.close(); });
  const status = await new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: address.port, headers: { host: 'peer.example' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    }); req.on('error', reject); req.end();
  });
  assert.equal(status, 200);
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/api/device/ws`, { headers: { host: 'peer.example' } });
  await once(ws, 'open');
  let next = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'remote.hello', protocolVersion: 1, deviceId: p.deviceId }));
  const challenge = JSON.parse((await next)[0].toString());
  next = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'remote.proof', nonce: challenge.nonce,
    signature: sign(null, Buffer.from(challenge.message), keys.privateKey).toString('base64url') }));
  assert.equal(JSON.parse((await next)[0].toString()).type, 'remote.welcome');
  const disconnected = once(ws, 'close');
  await server.close(); closed = true;
  await disconnected;
  assert.equal(ws.readyState, WebSocket.CLOSED);
});
