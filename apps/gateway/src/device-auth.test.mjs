import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createDeviceStore } from './device-store.mjs';
import { createDeviceAuthenticator } from './device-auth.mjs';

for (const keyType of ['registered', 'other']) {
  for (const state of ['active', 'revoked-during-proof', 'expired', 'disconnected']) {
    test(`device-auth-${keyType}-${state}`, t => {
      const store = createDeviceStore(':memory:'); t.after(() => store.close());
      const keys = generateKeyPairSync('ed25519');
      const p = store.beginPairing({ publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), name: 'Mac' });
      store.claimPairing('owner', p.challengeId, p.pairingKey);
      let time = 1000;
      const auth = createDeviceAuthenticator({ store, audience: 'https://peer.example', now: () => time });
      const c = auth.begin({ deviceId: p.deviceId, connectionId: 'socket-1' });
      const signingKey = keyType === 'registered' ? keys.privateKey : generateKeyPairSync('ed25519').privateKey;
      const response = { connectionId: 'socket-1', nonce: c.nonce,
        signature: sign(null, Buffer.from(c.message), signingKey).toString('base64url') };
      if (state === 'revoked-during-proof') store.revokeDevice('owner', p.deviceId);
      if (state === 'expired') time = c.expiresAt;
      if (state === 'disconnected') auth.disconnect('socket-1');
      if (keyType === 'registered' && state === 'active') {
        assert.deepEqual(auth.finish(response), { deviceId: p.deviceId, ownerId: 'owner', bindingVersion: 1, connectionId: 'socket-1' });
      } else assert.throws(() => auth.finish(response), /DEVICE_AUTH_DENIED/);
      assert.throws(() => auth.finish(response), /DEVICE_AUTH_DENIED/);
    });
  }
}

test('unknown, unclaimed and previously revoked devices cannot start reconnect authentication', t => {
  const store = createDeviceStore(':memory:'); t.after(() => store.close());
  const keys = generateKeyPairSync('ed25519');
  const p = store.beginPairing({ publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), name: 'Mac' });
  const auth = createDeviceAuthenticator({ store, audience: 'https://peer.example' });
  for (const deviceId of ['unknown', p.deviceId]) assert.throws(() => auth.begin({ deviceId, connectionId: 'socket' }), /DEVICE_AUTH_DENIED/);
  store.claimPairing('owner', p.challengeId, p.pairingKey);
  store.revokeDevice('owner', p.deviceId);
  assert.throws(() => auth.begin({ deviceId: p.deviceId, connectionId: 'socket' }), /DEVICE_AUTH_DENIED/);
});
