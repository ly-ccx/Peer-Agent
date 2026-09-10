import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeviceStore } from './device-store.mjs';

function key() { return generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString(); }
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'peer-gateway-'));
  const path = join(dir, 'control.sqlite');
  let now = 1000;
  const stores = new Set();
  t.after(() => { for (const store of stores) store.close(); rmSync(dir, { recursive: true, force: true }); });
  return {
    path, setNow(value) { now = value; },
    open() { const store = createDeviceStore(path, { now: () => now }); stores.add(store); return store; },
    close(store) { store.close(); stores.delete(store); },
  };
}

for (const account of ['owner', 'other']) {
  for (const state of ['bound', 'revoked']) {
    for (const reopen of [false, true]) {
      test(`device-${account}-${state}-${reopen ? 'reopen' : 'same-process'}`, t => {
        const f = fixture(t); let store = f.open();
        const pairing = store.beginPairing({ publicKey: key(), name: 'Mac mini' });
        assert.equal(pairing.pairingKey.length, 32);
        assert.equal(store.claimPairing('owner', pairing.challengeId, pairing.pairingKey).status, 'awaiting_device_ack');
        if (state === 'revoked') store.revokeDevice('owner', pairing.deviceId);
        if (reopen) { f.close(store); store = f.open(); }
        const list = store.listDevices(account);
        assert.equal(list.length, account === 'owner' ? 1 : 0);
        if (account === 'owner') {
          assert.equal(list[0].revoked, state === 'revoked');
          assert.equal(list[0].bindingVersion, state === 'revoked' ? 2 : 1);
          assert.equal('online' in list[0], false);
        } else assert.throws(() => store.revokeDevice(account, pairing.deviceId), /DEVICE_NOT_FOUND/);
        assert.throws(() => store.claimPairing(account, pairing.challengeId, pairing.pairingKey), /PAIRING_INVALID/);
      });
    }
  }
}

test('five failed attempts persist, expiry fails closed, replacement invalidates old Key', t => {
  const f = fixture(t); let store = f.open(); const publicKey = key();
  const p = store.beginPairing({ publicKey, name: 'Mac' });
  for (let i = 0; i < 5; i++) assert.throws(() => store.claimPairing('owner', p.challengeId, 'wrong'), /PAIRING_INVALID/);
  f.close(store); store = f.open();
  assert.throws(() => store.claimPairing('owner', p.challengeId, p.pairingKey), /PAIRING_INVALID/);
  const next = store.beginPairing({ publicKey, name: 'Mac' });
  assert.equal(next.deviceId, p.deviceId);
  const last = store.beginPairing({ publicKey, name: 'Mac' });
  assert.throws(() => store.claimPairing('owner', next.challengeId, next.pairingKey), /PAIRING_INVALID/);
  f.setNow(last.expiresAt);
  assert.throws(() => store.claimPairing('owner', last.challengeId, last.pairingKey), /PAIRING_INVALID/);
  assert.equal(store.listDevices('owner').length, 0);
});

test('two handles cannot claim twice or reassign revoked devices; Key not stored in plaintext', t => {
  const f = fixture(t); const a = f.open(); const b = f.open(); const publicKey = key();
  const p = a.beginPairing({ publicKey, name: 'Mac' });
  a.claimPairing('owner', p.challengeId, p.pairingKey);
  assert.throws(() => b.claimPairing('other', p.challengeId, p.pairingKey), /PAIRING_INVALID/);
  assert.throws(() => b.beginPairing({ publicKey, name: 'Mac' }), /DEVICE_ALREADY_BOUND/);
  assert.deepEqual(a.revokeDevice('owner', p.deviceId), a.revokeDevice('owner', p.deviceId));
  assert.throws(() => b.beginPairing({ publicKey, name: 'Mac' }), /DEVICE_ALREADY_BOUND/);
  f.close(a); f.close(b);
  assert.equal(readFileSync(f.path).includes(Buffer.from(p.pairingKey)), false);
});
