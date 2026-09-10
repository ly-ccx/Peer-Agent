import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { WebSocket } from 'ws';
import { createDeviceStore } from './device-store.mjs';
import { createGatewayHttpServer } from './http-server.mjs';
import { createRemoteBindingStore } from '../../../packages/runtime-node/src/remote-binding-store.mjs';
import { startRemoteDeviceConnector } from '../../../packages/runtime-node/src/remote-device-connector.mjs';

for (const action of ['disconnect', 'stop']) {
  test(`supervisor-real-socket-${action}`, { timeout: 8000 }, async t => {
    const remote = createDeviceStore(':memory:');
    const local = createRemoteBindingStore(':memory:');
    const origin = 'https://peer.example';
    const server = createGatewayHttpServer({ origin, deviceStore: remote,
      handle: async () => new Response(null, { status: 404 }) });
    const address = await server.listen();
    const keys = generateKeyPairSync('ed25519');
    const sockets = []; const timers = new Set(); const delays = [];
    let client;
    t.after(async () => {
      client?.stop(); for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.terminate();
      await server.close(); local.close(); remote.close();
    });
    let onlineCount = 0; let firstResolve; let secondResolve;
    const firstOnline = new Promise(resolve => { firstResolve = resolve; });
    const secondOnline = new Promise(resolve => { secondResolve = resolve; });
    client = startRemoteDeviceConnector({ origin, store: local, name: 'Mac',
      publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      sign: async message => sign(null, Buffer.from(message), keys.privateKey).toString('base64url'),
      socketFactory(url) {
        assert.equal(url, 'wss://peer.example/api/device/ws');
        const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/device/ws`, { headers: { host: 'peer.example' } });
        sockets.push(socket); return socket;
      },
      onState(event) {
        if (event.status === 'pairing') {
          // Verified account identity is a test precondition, not an IdP login.
          remote.claimPairing('owner', event.pairing.challengeId, event.pairing.pairingKey);
        }
        if (event.status === 'online') {
          onlineCount++;
          if (onlineCount === 1) firstResolve(event); else secondResolve(event);
        }
      },
    }, {
      random: () => 1,
      schedule(fn, delay) {
        delays.push(delay);
        // Accelerate only scheduling, not protocol handling or socket traffic.
        const timer = setTimeout(() => { timers.delete(timer); fn(); }, Math.min(delay, 10));
        timers.add(timer); return () => { clearTimeout(timer); timers.delete(timer); };
      },
    });
    const first = await firstOnline;
    assert.equal(sockets.length, 2, 'enrollment followed by authenticated reconnect');
    assert.equal(remote.bindingAcknowledged(local.load().deviceId), true);
    if (action === 'disconnect') {
      sockets.at(-1).terminate();
      const second = await secondOnline;
      assert.ok(second.connectionEpoch > first.connectionEpoch);
      assert.equal(sockets.length, 3);
      assert.deepEqual(delays, [0, 1000]);
    }
    client.stop();
    assert.equal((await client.closed).reason, 'stopped');
    const count = sockets.length;
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(sockets.length, count, 'explicit stop does not reconnect');
    assert.equal(timers.size, 0);
  });
}
