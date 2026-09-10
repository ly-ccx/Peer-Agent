import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { generateKeyPairSync, sign } from 'node:crypto';
import { WebSocket } from 'ws';
import { createDeviceStore } from './device-store.mjs';
import { createGatewayHttpServer } from './http-server.mjs';
import { createRemoteBindingStore } from '../../../packages/runtime-node/src/remote-binding-store.mjs';
import { startRemoteDeviceConnector } from '../../../packages/runtime-node/src/remote-device-connector.mjs';

for (const outcome of ['recover', 'stop']) {
  test(`connector-unavailable-then-${outcome}`, { timeout: 8000 }, async t => {
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const origin = 'https://peer.example';
    const remote = createDeviceStore(':memory:');
    const local = createRemoteBindingStore(':memory:');
    const keys = generateKeyPairSync('ed25519');
    const pairing = remote.beginPairing({ name: 'Mac', publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() });
    remote.claimPairing('owner', pairing.challengeId, pairing.pairingKey);
    const binding = { deviceId: pairing.deviceId, ownerId: 'owner', bindingVersion: 1 };
    local.save({ origin, ...binding }); remote.acknowledgeBinding(binding);
    const server = createGatewayHttpServer({ origin, deviceStore: remote, handle: async () => new Response(null, { status: 404 }) });
    let listening = false; let client;
    const sockets = []; const pending = []; const delays = [];
    let signalRetry;
    let retrySignal = new Promise(resolve => { signalRetry = resolve; });
    let signalOnline;
    const online = new Promise(resolve => { signalOnline = resolve; });
    t.after(async () => {
      client?.stop(); for (const socket of sockets) socket.terminate();
      // close also releases the transport's sweep timer when listen never happened.
      await server.close().catch(error => { if (listening || error.code !== 'ERR_SERVER_NOT_RUNNING') throw error; });
      local.close(); remote.close();
    });
    client = startRemoteDeviceConnector({ origin, store: local,
      sign: async message => sign(null, Buffer.from(message), keys.privateKey).toString('base64url'),
      socketFactory(url) {
        assert.equal(url, 'wss://peer.example/api/device/ws');
        const socket = new WebSocket(`ws://127.0.0.1:${port}/api/device/ws`, { headers: { host: 'peer.example' } });
        sockets.push(socket); return socket;
      },
      onState(event) { if (event.status === 'online') signalOnline(event); },
    }, {
      random: () => 1,
      schedule(fn, delay) {
        delays.push(delay); const entry = { fn, cancelled: false }; pending.push(entry);
        signalRetry(); return () => { entry.cancelled = true; };
      },
    });
    // Two real TCP refusals occur before service restoration; only time scheduling is controlled.
    await retrySignal;
    assert.deepEqual(delays, [1000]);
    retrySignal = new Promise(resolve => { signalRetry = resolve; });
    pending[0].fn();
    await retrySignal;
    assert.deepEqual(delays, [1000, 2000]);
    assert.equal(sockets.length, 2);
    if (outcome === 'stop') {
      client.stop();
      assert.equal(pending[1].cancelled, true);
      await server.listen(port); listening = true;
      pending[1].fn();
      assert.equal(sockets.length, 2, 'service recovery cannot override explicit stop');
      assert.equal((await client.closed).reason, 'stopped');
    } else {
      await server.listen(port); listening = true;
      pending[1].fn();
      assert.equal((await online).status, 'online');
      assert.equal(sockets.length, 3);
      assert.deepEqual(local.load(), { origin, ...binding, disabled: false });
      assert.equal(remote.bindingAcknowledged(binding.deviceId), true);
      client.stop();
    }
  });
}
