import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { request } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { WebSocket } from 'ws';
import { createDeviceStore } from './device-store.mjs';
import { createAccountSessions } from './account-sessions.mjs';
import { createAccountHttp } from './account-http.mjs';
import { createGatewayHttpServer } from './http-server.mjs';

for (const ending of ['disconnect', 'revoke']) {
  test(`device-list-live-${ending}`, { timeout: 5000 }, async t => {
    const origin = 'https://peer.example'; const ownerId = 'a'.repeat(64);
    const devices = createDeviceStore(':memory:'); const sessions = createAccountSessions(':memory:');
    const keys = generateKeyPairSync('ed25519');
    const p = devices.beginPairing({ name: 'Mac', publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() });
    devices.claimPairing(ownerId, p.challengeId, p.pairingKey);
    devices.acknowledgeBinding({ deviceId: p.deviceId, ownerId, bindingVersion: 1 });
    const server = createGatewayHttpServer({ origin, deviceStore: devices,
      handle: createAccountHttp({ origin, sessions, devices, login: {} }) });
    const address = await server.listen(); let ws;
    t.after(async () => { ws?.terminate(); await server.close(); devices.close(); sessions.close(); });
    const tokens = [sessions.issue({ ownerId }).token, sessions.issue({ ownerId: 'b'.repeat(64) }).token];
    async function list(token) {
      return new Promise((resolve, reject) => {
        const req = request({ hostname: '127.0.0.1', port: address.port, path: '/api/devices',
          headers: { host: 'peer.example', cookie: `__Host-peer_session=${token}` } }, res => {
          let body = ''; res.on('data', c => { body += c; });
          res.on('end', () => { try { assert.equal(res.statusCode, 200); resolve(JSON.parse(body).devices); } catch (e) { reject(e); } });
        }); req.on('error', reject); req.end();
      });
    }
    async function check(online) {
      assert.equal((await list(tokens[0]))[0].online, online);
      assert.deepEqual(await list(tokens[1]), []);
    }
    await check(false);
    ws = new WebSocket(`ws://127.0.0.1:${address.port}/api/device/ws`, { headers: { host: 'peer.example' } });
    await once(ws, 'open'); let next = once(ws, 'message');
    ws.send(JSON.stringify({ type: 'remote.hello', protocolVersion: 1, deviceId: p.deviceId }));
    const challenge = JSON.parse((await next)[0]); next = once(ws, 'message');
    ws.send(JSON.stringify({ type: 'remote.proof', nonce: challenge.nonce,
      signature: sign(null, Buffer.from(challenge.message), keys.privateKey).toString('base64url') }));
    assert.equal(JSON.parse((await next)[0]).type, 'remote.welcome');
    await check(true);
    if (ending === 'revoke') devices.revokeDevice(ownerId, p.deviceId);
    else {
      const closed = once(ws, 'close'); ws.close(); await closed;
      // Client close is not a barrier for the server's close callback. Observe
      // bounded convergence via the public API; never mask HTTP/storage errors.
      const deadline = performance.now() + 1000;
      while ((await list(tokens[0]))[0].online) {
        assert.ok(performance.now() < deadline, 'Gateway did not observe disconnect within 1s');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    await check(false);
  });
}
