import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID, createPublicKey } from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest('hex');
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);

/** Gateway control metadata only. ownerId MUST come from verified server-side auth.
 * This module neither authenticates browser requests nor executes device tasks.
 */
export function createDeviceStore(path, { now = Date.now } = {}) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (![0, 1, 2].includes(version)) { db.close(); throw new Error('SCHEMA_UNSUPPORTED'); }
  db.exec(`CREATE TABLE IF NOT EXISTS devices (
    device_id TEXT PRIMARY KEY, public_key TEXT NOT NULL UNIQUE, owner_id TEXT,
    name TEXT NOT NULL, binding_version INTEGER NOT NULL DEFAULT 1,
    revoked INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS pairings (
    challenge_id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(device_id),
    key_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, failures INTEGER NOT NULL DEFAULT 0,
    consumed INTEGER NOT NULL DEFAULT 0
  );`);
  // Additive migration: retain existing ownership/revocation, never infer an ack.
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS binding_acks (
      device_id TEXT PRIMARY KEY REFERENCES devices(device_id),
      binding_version INTEGER NOT NULL, acknowledged_at INTEGER NOT NULL
    );
    PRAGMA user_version=2;
    COMMIT;`);
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function clock() {
    const time = now();
    if (!Number.isSafeInteger(time) || time < 0) throw new Error('INVALID_CLOCK');
    return time;
  }
  function owner(value) { if (!id(value)) throw new Error('AUTH_REQUIRED'); }
  return {
    /** Called after device possession proof by the transport layer; never a browser API. */
    beginPairing({ publicKey, name }) {
      if (typeof publicKey !== 'string' || publicKey.length > 4096
          || typeof name !== 'string' || !name.trim() || name.length > 100) throw new Error('INVALID_DEVICE');
      const key = createPublicKey(publicKey);
      if (key.asymmetricKeyType !== 'ed25519') throw new Error('INVALID_DEVICE_KEY');
      const canonicalKey = key.export({ type: 'spki', format: 'pem' }).toString();
      const time = clock();
      return transaction(() => {
        let device = db.prepare('SELECT * FROM devices WHERE public_key=?').get(canonicalKey);
        if (device?.owner_id || device?.revoked) throw new Error('DEVICE_ALREADY_BOUND');
        if (!device) {
          const deviceId = randomUUID();
          db.prepare('INSERT INTO devices(device_id,public_key,name) VALUES(?,?,?)').run(deviceId, canonicalKey, name.trim());
          device = db.prepare('SELECT * FROM devices WHERE device_id=?').get(deviceId);
        }
        db.prepare('UPDATE pairings SET consumed=1 WHERE device_id=?').run(device.device_id);
        const challengeId = randomUUID();
        const pairingKey = randomBytes(24).toString('base64url');
        const expiresAt = time + 300_000;
        db.prepare('INSERT INTO pairings(challenge_id,device_id,key_hash,expires_at) VALUES(?,?,?,?)')
          .run(challengeId, device.device_id, digest(pairingKey), expiresAt);
        return { challengeId, pairingKey, deviceId: device.device_id, expiresAt };
      });
    },
    /** The public origin must additionally enforce per-account/source rate limits. */
    claimPairing(ownerId, challengeId, pairingKey) {
      owner(ownerId);
      if (!id(challengeId) || typeof pairingKey !== 'string' || pairingKey.length > 256) throw new Error('PAIRING_INVALID');
      const time = clock();
      // Return expected rejection from transaction so failed attempts are committed.
      const result = transaction(() => {
        const pairing = db.prepare('SELECT * FROM pairings WHERE challenge_id=?').get(challengeId);
        if (!pairing || pairing.consumed || pairing.failures >= 5 || pairing.expires_at <= time) return null;
        if (pairing.key_hash !== digest(pairingKey)) {
          db.prepare('UPDATE pairings SET failures=failures+1 WHERE challenge_id=?').run(challengeId);
          return null;
        }
        const changed = db.prepare('UPDATE devices SET owner_id=? WHERE device_id=? AND owner_id IS NULL AND revoked=0')
          .run(ownerId, pairing.device_id).changes;
        if (changed !== 1) return null;
        db.prepare('UPDATE pairings SET consumed=1 WHERE challenge_id=?').run(challengeId);
        return { deviceId: pairing.device_id, bindingVersion: 1, status: 'awaiting_device_ack' };
      });
      if (!result) throw new Error('PAIRING_INVALID');
      return result;
    },
    /** Server-internal lookup for possession proof; never expose as a browser API. */
    getDeviceBinding(deviceId) {
      if (!id(deviceId)) return null;
      const row = db.prepare(`SELECT device_id AS deviceId,public_key AS publicKey,
        owner_id AS ownerId,binding_version AS bindingVersion,revoked FROM devices WHERE device_id=?`).get(deviceId);
      return row ? { ...row, revoked: Boolean(row.revoked) } : null;
    },
    /** Call only from a possession-authenticated device connection, after local save. */
    acknowledgeBinding({ deviceId, ownerId, bindingVersion }) {
      owner(ownerId);
      if (!id(deviceId) || !Number.isSafeInteger(bindingVersion)) throw new Error('BINDING_DENIED');
      return transaction(() => {
        const row = db.prepare('SELECT * FROM devices WHERE device_id=?').get(deviceId);
        if (!row || row.revoked || row.owner_id !== ownerId || row.binding_version !== bindingVersion) throw new Error('BINDING_DENIED');
        db.prepare('INSERT INTO binding_acks VALUES(?,?,?) ON CONFLICT(device_id) DO NOTHING')
          .run(deviceId, bindingVersion, clock());
        return { deviceId, ownerId, bindingVersion, status: 'bound' };
      });
    },
    bindingAcknowledged(deviceId) {
      return Boolean(db.prepare(`SELECT 1 FROM devices d JOIN binding_acks a USING(device_id)
        WHERE d.device_id=? AND d.revoked=0 AND d.owner_id IS NOT NULL
          AND d.binding_version=a.binding_version`).get(deviceId));
    },
    listDevices(ownerId) {
      owner(ownerId);
      // No online flag: only authenticated live connections can establish liveness.
      return db.prepare('SELECT device_id AS deviceId,name,binding_version AS bindingVersion,revoked FROM devices WHERE owner_id=? ORDER BY device_id')
        .all(ownerId).map(row => ({ ...row, revoked: Boolean(row.revoked) }));
    },
    revokeDevice(ownerId, deviceId) {
      owner(ownerId);
      if (!id(deviceId)) throw new Error('DEVICE_NOT_FOUND');
      return transaction(() => {
        const device = db.prepare('SELECT * FROM devices WHERE owner_id=? AND device_id=?').get(ownerId, deviceId);
        if (!device) throw new Error('DEVICE_NOT_FOUND');
        if (!device.revoked) db.prepare('UPDATE devices SET revoked=1,binding_version=binding_version+1 WHERE device_id=?').run(deviceId);
        return { deviceId, bindingVersion: device.binding_version + (device.revoked ? 0 : 1), revoked: true };
      });
    },
    close() { db.close(); },
  };
}
