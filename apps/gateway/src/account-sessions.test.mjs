import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync } from 'node:crypto';
import { createAccountSessions } from './account-sessions.mjs';
import { createDeviceStore } from './device-store.mjs';

const ownerId = 'a'.repeat(64);
for (const browser of ['return', 'new', 'expired']) {
  for (const binding of ['bound', 'revoked']) {
    test(`LIFE-${browser}-${binding}`, t => {
      const dir = mkdtempSync(join(tmpdir(), 'peer-session-'));
      let now = 1000;
      let sessions = createAccountSessions(join(dir, 'sessions.sqlite'), { now: () => now, idleMs: 100, absoluteMs: 1000 });
      const devices = createDeviceStore(join(dir, 'devices.sqlite'));
      t.after(() => { sessions.close(); devices.close(); rmSync(dir, { recursive: true, force: true }); });
      const publicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
      const p = devices.beginPairing({ publicKey, name: 'Mac mini' });
      devices.claimPairing(ownerId, p.challengeId, p.pairingKey);
      let login = sessions.issue({ ownerId });
      if (binding === 'revoked') devices.revokeDevice(ownerId, p.deviceId);
      if (browser === 'return') {
        sessions.close();
        sessions = createAccountSessions(join(dir, 'sessions.sqlite'), { now: () => now, idleMs: 100, absoluteMs: 1000 });
      } else {
        if (browser === 'expired') { now += 100; assert.equal(sessions.authenticate(login.token), null); }
        // Simulates a subsequent verified login, not a real browser or IdP.
        login = sessions.issue({ ownerId });
      }
      const principal = sessions.authenticate(login.token);
      assert.equal(principal.ownerId, ownerId);
      const list = devices.listDevices(principal.ownerId);
      assert.equal(list.length, 1);
      assert.equal(list[0].deviceId, p.deviceId);
      assert.equal(list[0].revoked, binding === 'revoked');
      const other = sessions.issue({ ownerId: 'b'.repeat(64) });
      assert.deepEqual(devices.listDevices(sessions.authenticate(other.token).ownerId), []);
      sessions.revoke(login.token);
      assert.equal(sessions.authenticate(login.token), null);
      assert.equal(devices.listDevices(ownerId).length, 1, 'logout never unbinds device');
    });
  }
}

test('idle refresh is bounded by absolute expiry; revocation persists without affecting other sessions', t => {
  const dir = mkdtempSync(join(tmpdir(), 'peer-session-'));
  const path = join(dir, 'sessions.sqlite'); let now = 0;
  let store = createAccountSessions(path, { now: () => now, idleMs: 100, absoluteMs: 250 });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const a = store.issue({ ownerId }); const b = store.issue({ ownerId });
  store.revoke(a.token); store.close();
  assert.equal(readFileSync(path).includes(Buffer.from(a.token)), false);
  assert.equal(readFileSync(path).includes(Buffer.from(b.token)), false);
  store = createAccountSessions(path, { now: () => now, idleMs: 100, absoluteMs: 250 });
  assert.equal(store.authenticate(a.token), null);
  for (now of [90, 180, 249]) assert.equal(store.authenticate(b.token).ownerId, ownerId);
  now = 250; assert.equal(store.authenticate(b.token), null);
  assert.equal(store.authenticate('malformed'), null);
  assert.equal(store.prune(), 2);
});
