import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { parseRemoteReadRequest } from '@peer-agent/protocol';

// Lazy loading keeps node:sqlite out of unrelated runtime-node startup paths.
const require = createRequire(import.meta.url);

/** Local receipt ledger, not Gateway task truth or an execution/permission engine.
 * Callers must authenticate and check current resource visibility even for lookup.
 * New acceptance must be preceded by admitRemoteRead and local policy checks.
 */
export function createRemoteReceiptStore(path) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version !== 0 && version !== 1) {
    db.close();
    throw new Error('Unsupported remote receipt schema');
  }
  db.exec(`CREATE TABLE IF NOT EXISTS remote_receipts (
    owner_id TEXT NOT NULL, device_id TEXT NOT NULL, request_id TEXT NOT NULL,
    payload_hash TEXT NOT NULL, receipt_id TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK(state IN ('accepted','started','succeeded','failed')),
    evidence_ref TEXT, created_at INTEGER NOT NULL,
    PRIMARY KEY(owner_id, device_id, request_id)
  ); PRAGMA user_version = 1;`);
  const find = db.prepare('SELECT * FROM remote_receipts WHERE owner_id=? AND device_id=? AND request_id=?');
  const key = r => [r.ownerId, r.deviceId, r.requestId];
  const snapshot = row => row ? {
    receiptId: row.receipt_id, requestId: row.request_id, state: row.state,
    evidenceRef: row.evidence_ref, createdAt: row.created_at,
  } : null;
  function checked(value) {
    const parsed = parseRemoteReadRequest(value);
    if (!parsed.ok) throw new Error(parsed.code);
    return parsed.request;
  }
  function hash(r) {
    // Logical body excludes reconnect epoch and expiry, which are transport metadata.
    const body = [r.protocolVersion, r.type, r.ownerId, r.deviceId, r.workspaceId,
      r.bindingVersion, r.delegationVersion, r.operation, r.taskId];
    return createHash('sha256').update(JSON.stringify(body)).digest('hex');
  }
  return {
    lookup(value) {
      const r = checked(value);
      const row = find.get(...key(r));
      if (row && row.payload_hash !== hash(r)) throw new Error('REQUEST_CONFLICT');
      return snapshot(row);
    },
    accept(value, now) {
      const r = checked(value);
      if (!Number.isSafeInteger(now) || now < 0) throw new Error('INVALID_CLOCK');
      db.exec('BEGIN IMMEDIATE');
      try {
        let row = find.get(...key(r));
        if (row && row.payload_hash !== hash(r)) throw new Error('REQUEST_CONFLICT');
        const duplicate = Boolean(row);
        if (!row) {
          if (r.expiresAt <= now || r.expiresAt - now > 30_000) throw new Error('REQUEST_EXPIRED');
          db.prepare(`INSERT INTO remote_receipts VALUES (?, ?, ?, ?, ?, 'accepted', NULL, ?)`)
            .run(...key(r), hash(r), randomUUID(), now);
          row = find.get(...key(r));
        }
        db.exec('COMMIT');
        return { duplicate, receipt: snapshot(row) };
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    // A durable started marker is written before dispatch. Crashes leave it started:
    // no automatic reset/retry, because the external side effect may have happened.
    claim(value) {
      const r = checked(value);
      return db.prepare(`UPDATE remote_receipts SET state='started'
        WHERE owner_id=? AND device_id=? AND request_id=? AND payload_hash=? AND state='accepted'`)
        .run(...key(r), hash(r)).changes === 1;
    },
    finish(value, state, evidenceRef) {
      const r = checked(value);
      if (!['succeeded', 'failed'].includes(state) || typeof evidenceRef !== 'string' || !evidenceRef.trim()) {
        throw new Error('Terminal receipt requires actual execution evidence');
      }
      return db.prepare(`UPDATE remote_receipts SET state=?, evidence_ref=?
        WHERE owner_id=? AND device_id=? AND request_id=? AND payload_hash=? AND state='started'`)
        .run(state, evidenceRef, ...key(r), hash(r)).changes === 1;
    },
    close() { db.close(); },
  };
}
