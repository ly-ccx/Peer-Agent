import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDeviceStore } from './device-store.mjs';

// Historical v1 fixture: no binding_acks table. Never derive fixture via current migrations.
for (const state of ['active', 'revoked']) {
  for (const reopen of [false, true]) {
    test(`migration-v1-${state}-${reopen ? 'reopen' : 'initial'}`, t => {
      const dir = mkdtempSync(join(tmpdir(), 'peer-device-migration-'));
      const path = join(dir, 'devices.sqlite');
      let store;
      t.after(() => { store?.close(); rmSync(dir, { recursive: true, force: true }); });
      const old = new DatabaseSync(path);
      old.exec(`CREATE TABLE devices (
        device_id TEXT PRIMARY KEY, public_key TEXT NOT NULL UNIQUE, owner_id TEXT,
        name TEXT NOT NULL, binding_version INTEGER NOT NULL DEFAULT 1,
        revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE pairings (
        challenge_id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(device_id),
        key_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, failures INTEGER NOT NULL DEFAULT 0,
        consumed INTEGER NOT NULL DEFAULT 0
      ); PRAGMA user_version=1;`);
      old.prepare('INSERT INTO devices VALUES(?,?,?,?,?,?)').run('device', 'historical-public-key', 'owner', 'Mac', state === 'revoked' ? 2 : 1, state === 'revoked' ? 1 : 0);
      old.prepare('INSERT INTO pairings VALUES(?,?,?,?,?,?)').run('challenge', 'device', 'digest', 999999, 3, 1);
      old.close();
      store = createDeviceStore(path);
      assert.equal(store.bindingAcknowledged('device'), false, 'migration never invents local confirmation');
      if (state === 'active') store.acknowledgeBinding({ deviceId: 'device', ownerId: 'owner', bindingVersion: 1 });
      else assert.throws(() => store.acknowledgeBinding({ deviceId: 'device', ownerId: 'owner', bindingVersion: 2 }), /BINDING_DENIED/);
      if (reopen) { store.close(); store = createDeviceStore(path); }
      assert.equal(store.bindingAcknowledged('device'), state === 'active');
      const devices = store.listDevices('owner');
      assert.equal(devices.length, 1);
      assert.equal(devices[0].revoked, state === 'revoked');
      assert.equal(devices[0].bindingVersion, state === 'revoked' ? 2 : 1);
      assert.deepEqual(store.listDevices('other'), []);
      const inspect = new DatabaseSync(path);
      try {
        assert.equal(inspect.prepare('PRAGMA user_version').get().user_version, 2);
        assert.deepEqual({ ...inspect.prepare('SELECT failures,consumed FROM pairings').get() }, { failures: 3, consumed: 1 });
      } finally { inspect.close(); }
    });
  }
}

test('unsupported schema is rejected without replacing existing records', t => {
  const dir = mkdtempSync(join(tmpdir(), 'peer-device-version-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'devices.sqlite');
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES('preserve'); PRAGMA user_version=99;");
  db.close();
  assert.throws(() => createDeviceStore(path), /SCHEMA_UNSUPPORTED/);
  const check = new DatabaseSync(path);
  try {
    assert.equal(check.prepare('SELECT value FROM sentinel').get().value, 'preserve');
    assert.equal(check.prepare('PRAGMA user_version').get().user_version, 99);
  } finally { check.close(); }
});
