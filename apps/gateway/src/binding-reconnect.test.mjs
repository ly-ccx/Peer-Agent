import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { WebSocket } from 'ws';
import { createDeviceStore } from './device-store.mjs';
import { attachDeviceWebSocket } from './device-websocket.mjs';

for (const acknowledged of [false, true]) {
  for (const revoked of [false, true]) {
    test(`reconnect-ack-${acknowledged}-revoked-${revoked}`, { timeout: 5000 }, async t => {
      const store = createDeviceStore(':memory:');
      const keys = generateKeyPairSync('ed25519');
      const p = store.beginPairing({ name: 'Mac', publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() });
      store.claimPairing('owner', p.challengeId, p.pairingKey);
      const ack = { deviceId: p.deviceId, ownerId: 'owner', bindingVersion: 1 };
      if (acknowledged) store.acknowledgeBinding(ack);
      const server = createServer();
      const transport = attachDeviceWebSocket(server, { origin: 'https://peer.example', store });
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      const sockets = [];
      t.after(async () => { for (const ws of sockets) ws.terminate(); transport.close(); await new Promise(resolve => server.close(resolve)); store.close(); });
      async function connect(revoke = false) {
        const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/device/ws`, { headers: { host: 'peer.example' } });
        sockets.push(ws); await once(ws, 'open');
        let next = once(ws, 'message');
        ws.send(JSON.stringify({ type: 'remote.hello', protocolVersion: 1, deviceId: p.deviceId }));
        const challenge = JSON.parse((await next)[0].toString());
        if (revoke) store.revokeDevice('owner', p.deviceId);
        next = once(ws, revoke ? 'close' : 'message');
        ws.send(JSON.stringify({ type: 'remote.proof', nonce: challenge.nonce,
          signature: sign(null, Buffer.from(challenge.message), keys.privateKey).toString('base64url') }));
        const result = await next;
        return { ws, message: revoke ? null : JSON.parse(result[0].toString()) };
      }
      const first = await connect(revoked);
      if (revoked) { assert.throws(() => transport.connections.resolve('owner', p.deviceId)); return; }
      assert.equal(first.message.type, acknowledged ? 'remote.welcome' : 'remote.binding');
      if (!acknowledged) {
        assert.throws(() => transport.connections.resolve('owner', p.deviceId), /DEVICE_OFFLINE/);
        const confirmed = once(first.ws, 'message');
        first.ws.send(JSON.stringify({ type: 'remote.binding.ack', ...ack }));
        assert.equal(JSON.parse((await confirmed)[0].toString()).type, 'remote.binding.confirmed');
        assert.throws(() => transport.connections.resolve('owner', p.deviceId), /DEVICE_OFFLINE/);
        // Simulates lost enrollment connection/confirmation: new proof uses durable ack.
        first.ws.terminate();
        const second = await connect();
        assert.equal(second.message.type, 'remote.welcome');
      }
      assert.equal(transport.connections.resolve('owner', p.deviceId).deviceId, p.deviceId);
    });
  }
}
