import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);

/** Local binding metadata only: private keys belong to the credential vault.
 * A connector may send binding.ack only AFTER save returns successfully.
 * Loading this metadata alone neither authenticates a server nor authorizes tools.
 */
export function createRemoteBindingStore(path) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (![0, 1].includes(version)) throw new Error('BINDING_SCHEMA_UNSUPPORTED');
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS remote_binding (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        origin TEXT NOT NULL, device_id TEXT NOT NULL, owner_id TEXT NOT NULL,
        binding_version INTEGER NOT NULL, disabled INTEGER NOT NULL DEFAULT 0
      ); PRAGMA user_version=1; COMMIT;`);
  } catch (error) { db.close(); throw error; }
  const read = () => {
    const row = db.prepare(`SELECT origin,device_id AS deviceId,owner_id AS ownerId,
      binding_version AS bindingVersion,disabled FROM remote_binding WHERE singleton=1`).get();
    return row ? { ...row, disabled: Boolean(row.disabled) } : null;
  };
  return {
    load: read,
    save({ origin, deviceId, ownerId, bindingVersion }) {
      const url = new URL(origin);
      if (url.protocol !== 'https:' || url.origin !== origin || !id(deviceId) || !id(ownerId)
          || !Number.isSafeInteger(bindingVersion) || bindingVersion < 1) throw new Error('INVALID_BINDING');
      db.exec('BEGIN IMMEDIATE');
      try {
        const prior = read();
        // Remote messages cannot transfer ownership, change origin or undo a local stop.
        if (prior && (prior.origin !== origin || prior.deviceId !== deviceId || prior.ownerId !== ownerId
            || prior.bindingVersion !== bindingVersion)) throw new Error('BINDING_CONFLICT');
        if (!prior) db.prepare('INSERT INTO remote_binding VALUES(1,?,?,?,?,0)').run(origin, deviceId, ownerId, bindingVersion);
        db.exec('COMMIT');
        return read();
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    /** Local user action, not remotely callable. Disabled survives restart and save. */
    setDisabled(disabled) {
      if (typeof disabled !== 'boolean') throw new Error('INVALID_DISABLED');
      db.prepare('UPDATE remote_binding SET disabled=? WHERE singleton=1').run(disabled ? 1 : 0);
      return read();
    },
    close() { db.close(); },
  };
}
