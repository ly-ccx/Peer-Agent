import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync, sign } from 'node:crypto';
import { WebSocket } from 'ws';
import { createDeviceStore } from './device-store.mjs';
import { attachDeviceWebSocket } from './device-websocket.mjs';

for (const key of ['correct', 'wrong']) {
  for (const state of ['active', 'revoked']) {
    test(`ws-proof-${key}-${state}`, { timeout: 5000 }, async t => {
      const store = createDeviceStore(':memory:');
      const pair = generateKeyPairSync('ed25519');
      const p = store.beginPairing({ name: 'Mac', publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() });
      store.claimPairing('owner', p.challengeId, p.pairingKey);
      store.acknowledgeBinding({ deviceId: p.deviceId, ownerId: 'owner', bindingVersion: 1 });
      const server = createServer();
      const transport = attachDeviceWebSocket(server, { origin: 'https://peer.example', store });
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/device/ws`, { headers: { host: 'peer.example' } });
      t.after(async () => { ws.terminate(); transport.close(); await new Promise(resolve => server.close(resolve)); store.close(); });
      await once(ws, 'open');
      const challengeEvent = once(ws, 'message');
      ws.send(JSON.stringify({ type: 'remote.hello', protocolVersion: 1, deviceId: p.deviceId }));
      const challenge = JSON.parse((await challengeEvent)[0].toString());
      if (state === 'revoked') store.revokeDevice('owner', p.deviceId);
      const signingKey = key === 'correct' ? pair.privateKey : generateKeyPairSync('ed25519').privateKey;
      const success = key === 'correct' && state === 'active';
      const result = once(ws, success ? 'message' : 'close');
      ws.send(JSON.stringify({ type: 'remote.proof', nonce: challenge.nonce,
        signature: sign(null, Buffer.from(challenge.message), signingKey).toString('base64url') }));
      const response = await result;
      if (success) {
        assert.equal(JSON.parse(response[0].toString()).type, 'remote.welcome');
        assert.equal(transport.connections.resolve('owner', p.deviceId).deviceId, p.deviceId);
        const heartbeat = once(ws, 'message'); ws.send(JSON.stringify({ type: 'remote.heartbeat' }));
        assert.equal(JSON.parse((await heartbeat)[0].toString()).type, 'remote.heartbeat');
      } else assert.throws(() => transport.connections.resolve('owner', p.deviceId));
    });
  }
}
