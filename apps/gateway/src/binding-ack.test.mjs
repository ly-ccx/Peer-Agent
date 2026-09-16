import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { createDeviceStore } from './device-store.mjs';

for (const identity of ['correct', 'other-owner', 'other-device', 'old-version']) {
  for (const state of ['active', 'revoked']) {
    test(`binding-ack-${identity}-${state}`, t => {
      const store = createDeviceStore(':memory:'); t.after(() => store.close());
      const key = generateKeyPairSync('ed25519');
      const p = store.beginPairing({ name: 'Mac', publicKey: key.publicKey.export({ type: 'spki', format: 'pem' }).toString() });
      store.claimPairing('owner', p.challengeId, p.pairingKey);
      const ack = { deviceId: p.deviceId, ownerId: 'owner', bindingVersion: 1 };
      if (identity === 'other-owner') ack.ownerId = 'other';
      if (identity === 'other-device') ack.deviceId = 'other';
      if (identity === 'old-version') ack.bindingVersion = 0;
      if (state === 'revoked') store.revokeDevice('owner', p.deviceId);
      if (identity === 'correct' && state === 'active') {
        assert.equal(store.acknowledgeBinding(ack).status, 'bound');
        assert.equal(store.acknowledgeBinding(ack).status, 'bound');
        assert.equal(store.bindingAcknowledged(p.deviceId), true);
        store.revokeDevice('owner', p.deviceId);
        assert.equal(store.bindingAcknowledged(p.deviceId), false);
      } else {
        assert.throws(() => store.acknowledgeBinding(ack), /BINDING_DENIED/);
        assert.equal(store.bindingAcknowledged(p.deviceId), false);
      }
    });
  }
}
