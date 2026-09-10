import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { connectRemoteDevice } from './remote-device-connection.mjs';
import { startRemoteDeviceConnector } from './remote-device-connector.mjs';

async function closedPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
const options = port => ({ origin: `https://127.0.0.1:${port}`, deviceId: 'mac',
  store: { load: () => null }, sign: async () => { throw new Error('must not sign without server challenge'); } });

test('default Node WSS reports actual connection refusal as transient network failure', { timeout: 5000 }, async t => {
  const connection = connectRemoteDevice(options(await closedPort()));
  t.after(() => connection.stop());
  assert.equal((await connection.closed).reason, 'network_unavailable');
});

test('default WSS refusal schedules retry; explicit stop cancels it', { timeout: 5000 }, async t => {
  let scheduledResolve;
  const scheduled = new Promise(resolve => { scheduledResolve = resolve; });
  let cancelled = false;
  const client = startRemoteDeviceConnector(options(await closedPort()), {
    random: () => 1,
    schedule(fn, delay) {
      scheduledResolve({ fn, delay });
      return () => { cancelled = true; };
    },
  });
  t.after(() => client.stop());
  const retry = await scheduled;
  assert.equal(retry.delay, 1000);
  client.stop();
  assert.equal(cancelled, true);
  retry.fn();
  assert.equal((await client.closed).reason, 'stopped');
});
