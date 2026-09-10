import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createDeviceStore } from './device-store.mjs';
import { createGatewayHttpServer } from './http-server.mjs';
import { createRemoteBindingStore } from '../../../packages/runtime-node/src/remote-binding-store.mjs';
import { createRemoteDeviceHandshake } from '../../../packages/runtime-node/src/remote-device-handshake.mjs';

// Cross-module test uses real crypto and sockets; account claim is a verified-login
// precondition. No IdP, Keychain, TLS proxy or Runtime execution is represented here.
for (const reopen of [false, true]) {
  for (const disabled of [false, true]) {
    test(`local-network-handshake-reopen-${reopen}-disabled-${disabled}`, { timeout: 8000 }, async t => {
      const dir = mkdtempSync(join(tmpdir(), 'peer-handshake-integration-'));
      const path = join(dir, 'local.sqlite');
      let local = createRemoteBindingStore(path);
      const remote = createDeviceStore(':memory:');
      const origin = 'https://peer.example';
      const keys = generateKeyPairSync('ed25519');
      const server = createGatewayHttpServer({ origin, deviceStore: remote, handle: async () => new Response(null, { status: 404 }) });
      const address = await server.listen();
      const sockets = [];
      t.after(async () => {
        for (const socket of sockets) socket.terminate();
        await server.close(); local.close(); remote.close();
        rmSync(dir, { recursive: true, force: true });
      });
      async function connection() {
        const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/device/ws`, { headers: { host: 'peer.example' } });
        sockets.push(socket); await once(socket, 'open');
        const sent = [];
        const handshake = createRemoteDeviceHandshake({ origin, store: local,
          publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), name: 'Mac mini',
          sign: async message => sign(null, Buffer.from(message), keys.privateKey).toString('base64url'),
          send(message) {
            if (message.type === 'remote.binding.ack') {
              assert.equal(local.load().ownerId, 'owner');
              assert.equal(local.load().disabled, false);
            }
            sent.push(message); socket.send(JSON.stringify(message));
          },
        });
        return { socket, handshake, sent };
      }
      const first = await connection();
      let response = once(first.socket, 'message'); first.handshake.start();
      const challenge = JSON.parse((await response)[0].toString());
      response = once(first.socket, 'message');
      await first.handshake.receive(challenge);
      const pairingResult = await first.handshake.receive(JSON.parse((await response)[0].toString()));
      assert.equal(pairingResult.status, 'pairing');
      const pairing = pairingResult.pairing;
      remote.claimPairing('owner', pairing.challengeId, pairing.pairingKey);
      response = once(first.socket, 'message');
      first.socket.send(JSON.stringify({ type: 'remote.binding.query' }));
      const binding = JSON.parse((await response)[0].toString());
      response = once(first.socket, 'message');
      assert.equal((await first.handshake.receive(binding)).status, 'saved');
      assert.equal((await first.handshake.receive(JSON.parse((await response)[0].toString()))).status, 'reconnect');
      assert.equal(remote.bindingAcknowledged(pairing.deviceId), true);
      first.socket.terminate();
      if (disabled) local.setDisabled(true);
      if (reopen) { local.close(); local = createRemoteBindingStore(path); }
      const second = await connection();
      if (disabled) {
        assert.throws(() => second.handshake.start(), /REMOTE_DISABLED/);
        assert.equal(second.sent.length, 0);
        return;
      }
      response = once(second.socket, 'message'); second.handshake.start();
      const nextChallenge = JSON.parse((await response)[0].toString());
      response = once(second.socket, 'message'); await second.handshake.receive(nextChallenge);
      const online = await second.handshake.receive(JSON.parse((await response)[0].toString()));
      assert.equal(online.status, 'online');
      assert.ok(online.connectionEpoch > 0);
      assert.equal(local.load().deviceId, pairing.deviceId);
    });
  }
}
