import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startRemoteDeviceConnector } from './remote-device-connector.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
for (const code of ['ECONNREFUSED', 'EAI_AGAIN', 'CERT_HAS_EXPIRED', 'UNKNOWN']) {
  for (const stop of [false, true]) {
    test(`network-code-${code}-stop-${stop}`, async () => {
      const sockets = []; const timers = [];
      const client = startRemoteDeviceConnector({ origin: 'https://peer.example',
        deviceId: 'mac', store: { load: () => null }, sign: async () => '',
        socketFactory() {
          const socket = new EventTarget(); socket.readyState = 0; socket.close = () => {};
          sockets.push(socket); return socket;
        },
      }, { random: () => 1, schedule(fn, delay) { const timer = { fn, delay }; timers.push(timer); return () => {}; } });
      try {
        if (stop) client.stop();
        const event = new Event('error');
        event.error = { cause: { code } };
        sockets[0].dispatchEvent(event); await flush();
        const retry = !stop && ['ECONNREFUSED', 'EAI_AGAIN'].includes(code);
        assert.equal(timers.length, retry ? 1 : 0);
        if (retry) {
          assert.equal(timers[0].delay, 1000);
          timers[0].fn();
          assert.equal(sockets.length, 2);
          const again = new Event('error'); again.error = { code };
          sockets[1].dispatchEvent(again); await flush();
          assert.equal(timers[1].delay, 2000, 'pre-auth failures retain backoff');
          client.stop(); timers[1].fn();
          assert.equal(sockets.length, 2, 'late retry cannot override stop');
        } else {
          assert.equal((await client.closed).reason, stop ? 'stopped' : 'transport_failure');
        }
      } finally { client.stop(); }
    });
  }
}
