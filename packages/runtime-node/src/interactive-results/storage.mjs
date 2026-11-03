import { randomUUID, createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from '../sqlite/connection.mjs';
import { INTERACTIVE_RESULT_LIMITS as L, interactiveToken } from '@peer-agent/protocol';
import { canonicalJSON } from '@peer-agent/interactive-content/values';

export const problem = code => Object.assign(Error(code), { code });
export const jsonDigest = value => `sha256:${createHash('sha256').update(canonicalJSON(value), 'utf8').digest('hex')}`;
export const encode = value => canonicalJSON(value);
export function decode(body) { try { return JSON.parse(body); } catch { throw problem('interactive_storage_corrupt'); } }

function directory(parent, name) {
  const target = path.join(parent, name);
  try { mkdirSync(target, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw problem('interactive_storage_unavailable');
  return target;
}
function fileIdentity(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw problem('interactive_storage_unavailable');
  return `${stat.dev}:${stat.ino}`;
}
function assertDirectory(folder) {
  const stat = lstatSync(folder);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw problem('interactive_storage_unavailable');
}

/** Per-workspace SQLite commits objects, versions, operation receipts and outbox rows atomically. */
export function createInteractiveStorage({ rootDir, assertCompatibility, maxBytes = L.storeBytes, hostEpoch = randomUUID() }) {
  const connections = new Map();
  let canonicalRoot = existsSync(rootDir) ? realpathSync(rootDir) : path.resolve(rootDir);
  let disposed = false;
  function connect(workspaceId, create = false) {
    if (disposed || !interactiveToken(workspaceId)) throw problem('interactive_storage_unavailable');
    if (create && (typeof assertCompatibility !== 'function' || assertCompatibility(workspaceId) !== true)) throw problem('interactive_compatibility_unavailable');
    const cached = connections.get(workspaceId);
    if (cached && (!create || !cached.readOnly)) { cached.assertFile(); return cached; }
    let folder = path.join(canonicalRoot, workspaceId, 'interactive-results'), file = path.join(folder, 'store.sqlite');
    for (const ancestor of [path.join(canonicalRoot, workspaceId), folder]) if (existsSync(ancestor)) assertDirectory(ancestor);
    if (existsSync(folder) && !existsSync(file)) throw problem('interactive_storage_missing');
    if (!create && !existsSync(file)) return null;
    if (create) {
      mkdirSync(canonicalRoot, { recursive: true, mode: 0o700 });
      canonicalRoot = realpathSync(canonicalRoot);
      folder = path.join(canonicalRoot, workspaceId, 'interactive-results'); file = path.join(folder, 'store.sqlite');
      const workspace = directory(canonicalRoot, workspaceId); directory(workspace, 'interactive-results');
      if (!existsSync(file)) { const fd = openSync(file, 'wx', 0o600); closeSync(fd); }
    }
    for (const suffix of ['', '-wal', '-shm', '-journal']) if (existsSync(file + suffix)) fileIdentity(file + suffix);
    const identity = fileIdentity(file);
    cached?.db.close(); connections.delete(workspaceId);
    const db = new DatabaseSync(file, { readOnly: !create });
    try {
      db.exec('PRAGMA busy_timeout=0;');
      const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
      if (![0, 2].includes(version) || !create && version !== 2 || db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw problem('interactive_storage_incompatible');
      if (version === 0 && db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length) throw problem('interactive_storage_corrupt');
      if (create) db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA journal_size_limit=8388608; PRAGMA wal_autocheckpoint=128;');
      if (version === 0) db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE objects(hash TEXT PRIMARY KEY, body TEXT NOT NULL, bytes INTEGER NOT NULL);
        CREATE TABLE results(id TEXT PRIMARY KEY, owner TEXT NOT NULL, head TEXT NOT NULL);
        CREATE TABLE versions(id TEXT NOT NULL, version TEXT NOT NULL, owner TEXT NOT NULL, object TEXT NOT NULL, metadata TEXT NOT NULL, availability TEXT NOT NULL DEFAULT 'available', PRIMARY KEY(id,version));
        CREATE TABLE operations(id TEXT PRIMARY KEY, owner TEXT NOT NULL, conversation TEXT NOT NULL, toolCallId TEXT NOT NULL, argsDigest TEXT NOT NULL, phase TEXT NOT NULL, receipt TEXT NOT NULL);
        CREATE TABLE states(id TEXT NOT NULL, version TEXT NOT NULL, snapshot TEXT NOT NULL, writer TEXT, PRIMARY KEY(id,version));
        CREATE TABLE saves(id TEXT NOT NULL, version TEXT NOT NULL, requestId TEXT NOT NULL, argsDigest TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(id,version,requestId));
        CREATE TABLE followups(id TEXT PRIMARY KEY, owner TEXT NOT NULL, argsDigest TEXT NOT NULL, snapshot TEXT NOT NULL);
        CREATE TABLE materials(id TEXT PRIMARY KEY, owner TEXT NOT NULL, object TEXT NOT NULL, metadata TEXT NOT NULL);
        PRAGMA user_version=2; COMMIT;`);
      const context = { db, file, readOnly: !create, hostEpoch, assertFile() {
        assertDirectory(path.dirname(folder)); assertDirectory(folder);
        if (identity !== fileIdentity(file)) throw problem('interactive_storage_replaced');
        if (Number(db.prepare('PRAGMA user_version').get()?.user_version) !== 2) throw problem('interactive_storage_incompatible');
        for (const suffix of ['-wal', '-shm', '-journal']) if (existsSync(file + suffix)) fileIdentity(file + suffix);
      } };
      connections.set(workspaceId, context); return context;
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} db.close(); throw error; }
  }
  function budget(context) {
    const stored = context.db.prepare('SELECT COALESCE(SUM(bytes),0) AS bytes FROM objects').get().bytes;
    let manifest = 0;
    const metadata = ['versions', 'operations', 'states', 'followups', 'materials', 'saves'].reduce((sum, table) => {
      const field = ({ versions: 'metadata', operations: 'receipt', states: 'snapshot', followups: 'snapshot', materials: 'metadata', saves: 'receipt' })[table];
      const bytes = Number(context.db.prepare(`SELECT COALESCE(SUM(length(CAST(${field} AS BLOB))),0) AS bytes FROM ${table}`).get().bytes);
      if (['versions', 'operations', 'materials'].includes(table)) manifest += bytes;
      return sum + bytes;
    }, 0);
    if (Number(stored) + metadata > maxBytes) throw problem('interactive_store_limit');
    if (manifest > L.manifestBytes) throw problem('interactive_manifest_limit');
  }
  function transaction(workspaceId, callback) {
    const context = connect(workspaceId, true);
    context.assertFile(); context.db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback(context);
      if (result?.then) throw problem('interactive_async_transaction');
      budget(context); context.assertFile(); context.db.exec('COMMIT'); return result;
    } catch (error) { try { context.db.exec('ROLLBACK'); } catch {} throw error; }
  }
  function putObject(context, value) {
    const body = encode(value), hash = jsonDigest(value), bytes = Buffer.byteLength(body, 'utf8');
    const previous = context.db.prepare('SELECT body,bytes FROM objects WHERE hash=?').get(hash);
    if (previous && (previous.bytes !== bytes || previous.body !== body)) throw problem('interactive_storage_corrupt');
    if (!previous) context.db.prepare('INSERT INTO objects VALUES(?,?,?)').run(hash, body, bytes);
    return hash;
  }
  function readObject(context, hash) {
    const row = context.db.prepare('SELECT body,bytes FROM objects WHERE hash=?').get(hash);
    if (!row || Buffer.byteLength(row.body, 'utf8') !== row.bytes) throw problem('interactive_content_missing');
    const value = decode(row.body);
    if (jsonDigest(value) !== hash) throw problem('interactive_content_corrupt');
    return value;
  }
  return { connect, transaction, putObject, readObject, hostEpoch,
    close() { disposed = true; for (const context of connections.values()) context.db.close(); connections.clear(); } };
}
