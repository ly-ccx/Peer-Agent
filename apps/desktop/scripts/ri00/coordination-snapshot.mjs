/**
 * Read port for a consistent backup of the existing derived SQLite database.
 * These SELECTs mirror coordination-storage-v2's public read shape. No source
 * token/fence is rewritten and no writer/lease is granted by this adapter.
 * It deliberately cannot measure source-token validation or recovery cost.
 */
export function createCoordinationSnapshot(db) {
  const statements = new Map();
  const statement = sql => { if (!statements.has(sql)) statements.set(sql, db.prepare(sql)); return statements.get(sql); };
  const all = bucket => Object.fromEntries(statement('SELECT id,value FROM objects WHERE bucket=?').all(bucket)
    .map(row => [row.id, JSON.parse(row.value)]));
  const get = (bucket, id) => { const row = statement('SELECT value FROM objects WHERE bucket=? AND id=?').get(bucket, id); return row ? JSON.parse(row.value) : undefined; };
  const meta = id => { const row = statement('SELECT value FROM meta WHERE id=?').get(id); return row ? JSON.parse(row.value) : undefined; };
  let cached;
  const freeze = value => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value); for (const child of Object.values(value)) freeze(child);
    }
    return value;
  };
  return {
    revision: () => meta('revision') || 0,
    readLifecycleFacts() {
      const state = { revision: meta('revision') || 0 };
      for (const key of ['mandates', 'transitions', 'decisions']) state[key] = all(key);
      state.workStates = Object.fromEntries(Object.entries(all('works')).map(([id, work]) =>
        [id, { state: work.state, stopScope: work.stopScope, intentCoordination: work.intentCoordination }]));
      return state;
    },
    readSnapshot() {
      if (!cached) {
        cached = { revision: meta('revision') || 0, works: {}, events: {}, deliveries: {} };
        for (const { bucket } of db.prepare('SELECT DISTINCT bucket FROM objects').all()) cached[bucket] = all(bucket);
        const recovery = meta('lastRecovery'); if (recovery) cached.lastRecovery = recovery;
        freeze(cached);
      }
      return cached;
    },
    readWork: id => get('works', id),
    readSessionControl(id) { const head = get('sessionControlHeads', id); return head ? get('sessionControls', head.operationId) : undefined; },
    readSupervision: (bucket, id) => get(bucket, id),
    assertOwner() { throw new Error('ri00_snapshot_has_no_writer_authority'); },
    close: () => db.close(),
  };
}
