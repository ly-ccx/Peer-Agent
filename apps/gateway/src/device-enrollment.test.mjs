import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { generateKeyPairSync, sign } from 'node:crypto';
import { WebSocket } from 'ws';
import { createDeviceStore } from './device-store.mjs';
import { createGatewayHttpServer } from './http-server.mjs';
import { createAccountHttp } from './account-http.mjs';
import { createAccountSessions } from './account-sessions.mjs';

for (const proof of ['valid', 'invalid']) {
  for (const account of ['authenticated', 'anonymous']) {
    test(`enroll-${proof}-${account}`, { timeout: 5000 }, async t => {
      const store = createDeviceStore(':memory:');
      const sessions = createAccountSessions(':memory:');
      const ownerId = 'a'.repeat(64);
      const origin = 'https://peer.example';
      const http = createAccountHttp({ origin, sessions, devices: store, login: {} });
      const server = createGatewayHttpServer({ origin, deviceStore: store, handle: http });
      const address = await server.listen();
      const ws = new WebSocket(`ws://127.0.0.1:${address.port}/api/device/ws`, { headers: { host: 'peer.example' } });
      t.after(async () => { ws.terminate(); await server.close(); sessions.close(); store.close(); });
      await once(ws, 'open');
      const keys = generateKeyPairSync('ed25519');
      let next = once(ws, 'message');
      ws.send(JSON.stringify({ type: 'remote.enroll', protocolVersion: 1, name: 'Mac mini',
        publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }));
      const challenge = JSON.parse((await next)[0].toString());
      next = once(ws, proof === 'valid' ? 'message' : 'close');
      ws.send(JSON.stringify({ type: 'remote.proof', nonce: challenge.nonce,
        signature: sign(null, Buffer.from(challenge.message), proof === 'valid' ? keys.privateKey : generateKeyPairSync('ed25519').privateKey).toString('base64url') }));
      const result = await next;
      if (proof === 'invalid') { assert.deepEqual(store.listDevices(ownerId), []); return; }
      const pairing = JSON.parse(result[0].toString());
      assert.equal(pairing.type, 'remote.pairing');
      next = once(ws, 'message'); ws.send(JSON.stringify({ type: 'remote.binding.query' }));
      assert.equal(JSON.parse((await next)[0].toString()).type, 'remote.binding.pending');
      // Account authentication is a test precondition, not a real IdP login.
      const token = sessions.issue({ ownerId }).token;
      const response = await http(new Request(origin + '/api/pairings/claim', { method: 'POST',
        headers: { origin, 'content-type': 'application/json',
          ...(account === 'authenticated' ? { cookie: `__Host-peer_session=${token}` } : {}) },
        body: JSON.stringify({ challengeId: pairing.challengeId, pairingKey: pairing.pairingKey }) }));
      assert.equal(response.status, account === 'authenticated' ? 202 : 401);
      next = once(ws, 'message'); ws.send(JSON.stringify({ type: 'remote.binding.query' }));
      const binding = JSON.parse((await next)[0].toString());
      assert.equal(binding.type, account === 'authenticated' ? 'remote.binding' : 'remote.binding.pending');
      if (account === 'authenticated') {
        assert.equal(binding.ownerId, ownerId);
        assert.equal(binding.status, 'awaiting_device_ack');
        assert.equal(binding.deviceId, pairing.deviceId);
        assert.equal(store.bindingAcknowledged(pairing.deviceId), false);
        for (let attempt = 0; attempt < 2; attempt++) {
          next = once(ws, 'message');
          ws.send(JSON.stringify({ type: 'remote.binding.ack', deviceId: binding.deviceId,
            ownerId: binding.ownerId, bindingVersion: binding.bindingVersion }));
          assert.equal(JSON.parse((await next)[0].toString()).type, 'remote.binding.confirmed');
        }
        assert.equal(store.bindingAcknowledged(pairing.deviceId), true);
      }
    });
  }
}
