import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';

const hash = token => createHash('sha256').update(token).digest('hex');
const validToken = token => typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);

/** Server-internal session store. Issue only after verified OIDC identity.
 * Tokens belong in Secure/HttpOnly cookies, never URLs or browser localStorage.
 * This database is separate from device metadata; logout never changes bindings.
 */
export function createAccountSessions(path, { now = Date.now, idleMs = 3_600_000, absoluteMs = 86_400_000 } = {}) {
  if (![idleMs, absoluteMs].every(v => Number.isSafeInteger(v) && v > 0)
      || idleMs > absoluteMs || absoluteMs > 30 * 86_400_000) throw new Error('INVALID_SESSION_LIFETIME');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (![0, 1].includes(version)) { db.close(); throw new Error('SESSION_SCHEMA_UNSUPPORTED'); }
  db.exec(`CREATE TABLE IF NOT EXISTS account_sessions (
    token_hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL,
    idle_expires INTEGER NOT NULL, absolute_expires INTEGER NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0
  ); PRAGMA user_version=1;`);
  const clock = () => {
    const time = now();
    if (!Number.isSafeInteger(time) || time < 0 || !Number.isSafeInteger(time + absoluteMs)) throw new Error('INVALID_CLOCK');
    return time;
  };
  return {
    issue(identity) {
      // Identity shape is not authentication. Only the HTTP login composition calls this.
      if (!identity || typeof identity.ownerId !== 'string' || !/^[a-f0-9]{64}$/.test(identity.ownerId)) {
        throw new Error('INVALID_IDENTITY');
      }
      const time = clock();
      const token = randomBytes(32).toString('base64url');
      db.prepare('INSERT INTO account_sessions VALUES(?,?,?,?,0)')
        .run(hash(token), identity.ownerId, time + idleMs, time + absoluteMs);
      return { token, expiresAt: time + absoluteMs };
    },
    authenticate(token) {
      if (!validToken(token)) return null;
      const time = clock();
      // Atomic touch + read prevents a concurrent revoke from being undone by a refresh.
      const row = db.prepare(`UPDATE account_sessions SET idle_expires=MIN(?,absolute_expires)
        WHERE token_hash=? AND revoked=0 AND idle_expires>? AND absolute_expires>?
        RETURNING owner_id AS ownerId, absolute_expires AS expiresAt`)
        .get(time + idleMs, hash(token), time, time);
      return row ? Object.freeze({ ...row }) : null;
    },
    revoke(token) {
      if (!validToken(token)) return;
      db.prepare('UPDATE account_sessions SET revoked=1 WHERE token_hash=?').run(hash(token));
    },
    prune() {
      const time = clock();
      return db.prepare('DELETE FROM account_sessions WHERE revoked=1 OR idle_expires<=? OR absolute_expires<=?')
        .run(time, time).changes;
    },
    close() { db.close(); },
  };
}
