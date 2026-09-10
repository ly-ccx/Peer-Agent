import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { WebSocket } from 'ws';
import { createDeviceStore } from './device-store.mjs';
import { createGatewayHttpServer } from './http-server.mjs';
import { createRemoteBindingStore } from '../../../packages/runtime-node/src/remote-binding-store.mjs';
import { connectRemoteDevice } from '../../../packages/runtime-node/src/remote-device-connection.mjs';

for (const saveFails of [false, true]) {
  test(`connector-drives-enrollment-save-fails-${saveFails}`, { timeout: 8000 }, async t => {
    const remote = createDeviceStore(':memory:');
    const local = createRemoteBindingStore(':memory:');
    const origin = 'https://peer.example';
    const server = createGatewayHttpServer({ origin, deviceStore: remote, handle: async () => new Response(null, { status: 404 }) });
    const address = await server.listen(); const sockets = []; const clients = [];
    t.after(async () => { for (const c of clients) c.stop(); for (const s of sockets) s.terminate(); await server.close(); local.close(); remote.close(); });
    const keys = generateKeyPairSync('ed25519');
    const options = { origin, publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), name: 'Mac',
      store: { load: local.load, save(value) { if (saveFails) throw new Error('DISK'); return local.save(value); } },
      sign: async message => sign(null, Buffer.from(message), keys.privateKey).toString('base64url'),
      socketFactory(url) {
        assert.equal(url, 'wss://peer.example/api/device/ws');
        const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/device/ws`, { headers: { host: 'peer.example' } });
        sockets.push(socket); return socket;
      },
    };
    let deviceId;
    const first = connectRemoteDevice({ ...options, onState(event) {
      if (event.status === 'pairing') {
        deviceId = event.pairing.deviceId;
        remote.claimPairing('owner', event.pairing.challengeId, event.pairing.pairingKey);
      }
    } }); clients.push(first);
    assert.equal((await first.closed).reason, saveFails ? 'protocol_failure' : 'reconnect');
    assert.equal(remote.bindingAcknowledged(deviceId), !saveFails);
    if (saveFails) { assert.equal(local.load(), null); return; }
    let onlineResolve;
    const online = new Promise(resolve => { onlineResolve = resolve; });
    const second = connectRemoteDevice({ ...options, onState(event) { if (event.status === 'online') onlineResolve(event); } });
    clients.push(second);
    assert.equal((await online).status, 'online');
    second.stop(); assert.equal((await second.closed).reason, 'stopped');
    local.setDisabled(true);
    const before = sockets.length;
    assert.throws(() => connectRemoteDevice(options), /REMOTE_DISABLED/);
    assert.equal(sockets.length, before, 'disabled must not create a socket');
  });
}
