import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createDeviceStore } from './device-store.mjs';
import { createDeviceAuthenticator } from './device-auth.mjs';
import { createDeviceConnections } from './device-connections.mjs';

function setup(t) {
  let now = 1000;
  const store = createDeviceStore(':memory:');
  const keys = generateKeyPairSync('ed25519');
  const pairing = store.beginPairing({ name: 'Mac', publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() });
  store.claimPairing('owner', pairing.challengeId, pairing.pairingKey);
  const auth = createDeviceAuthenticator({ store, audience: 'https://peer.example', now: () => now });
  const connections = createDeviceConnections({ store, now: () => now });
  t.after(() => { connections.close(); store.close(); });
  const principal = connectionId => {
    const challenge = auth.begin({ deviceId: pairing.deviceId, connectionId });
    return auth.finish({ connectionId, nonce: challenge.nonce,
      signature: sign(null, Buffer.from(challenge.message), keys.privateKey).toString('base64url') });
  };
  return { store, connections, principal, deviceId: pairing.deviceId, setTime(value) { now = value; } };
}

for (const account of ['owner', 'other']) {
  for (const state of ['online', 'expired', 'revoked', 'disconnected']) {
    test(`connections-${account}-${state}`, t => {
      const f = setup(t); let closed = 0;
      const handle = f.connections.attach(f.principal('socket'), { close() { closed++; } });
      if (state === 'expired') f.setTime(61_000);
      if (state === 'revoked') f.store.revokeDevice('owner', f.deviceId);
      if (state === 'disconnected') f.connections.disconnect(handle);
      if (account === 'owner' && state === 'online') assert.equal(f.connections.resolve(account, f.deviceId), handle);
      else assert.throws(() => f.connections.resolve(account, f.deviceId),
        account === 'other' || state === 'revoked' ? /DEVICE_UNAVAILABLE/ : /DEVICE_OFFLINE/);
      f.connections.sweep();
      assert.equal(closed, state === 'online' ? 0 : 1);
      if (state !== 'online') assert.equal(f.connections.heartbeat(handle), false);
    });
  }
}

test('new connection invalidates old handle; late close/heartbeat cannot affect replacement', t => {
  const f = setup(t); let closed = 0;
  const old = f.connections.attach(f.principal('old'), { close() { closed++; } });
  const current = f.connections.attach(f.principal('new'), { close() {} });
  assert.equal(closed, 1);
  assert.ok(current.epoch > old.epoch);
  assert.equal(f.connections.heartbeat(old), false);
  f.connections.disconnect(old);
  assert.equal(f.connections.resolve('owner', f.deviceId), current);
  assert.equal(f.connections.heartbeat({ ...current }), false, 'wire clone is not a server connection handle');
  f.setTime(60_000); assert.equal(f.connections.heartbeat(current), true);
  f.setTime(119_999); assert.equal(f.connections.resolve('owner', f.deviceId), current);
  f.setTime(120_000); assert.throws(() => f.connections.resolve('owner', f.deviceId), /DEVICE_OFFLINE/);
});

test('new registry has no persisted online state; revoked principal cannot reattach', t => {
  const f = setup(t); const principal = f.principal('socket');
  f.connections.attach(principal, { close() {} });
  const fresh = createDeviceConnections({ store: f.store });
  assert.throws(() => fresh.resolve('owner', f.deviceId), /DEVICE_OFFLINE/);
  f.store.revokeDevice('owner', f.deviceId);
  assert.throws(() => f.connections.attach(principal, { close() {} }), /DEVICE_AUTH_DENIED/);
});
