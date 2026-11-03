import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, rmSync } from 'node:fs';

const LIMIT = 32 * 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const fail = code => Object.assign(Error(code), { code });

function identity(file) {
  try {
    const stat = lstatSync(file, { bigint: true });
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function readRows(file, maxBytes, missingAllowed) {
  let fd;
  try { fd = openSync(file, 'r'); }
  catch (error) {
    if (error.code === 'ENOENT' && missingAllowed) return { rows: [], bytes: 0 };
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) throw fail('CONVERSATION_RETENTION_LIMIT');
    const body = Buffer.alloc(stat.size + 1);
    let bytes = 0;
    while (bytes < body.length) {
      const read = readSync(fd, body, bytes, body.length - bytes, null);
      if (read === 0) break;
      bytes += read;
    }
    if (bytes !== stat.size) throw fail('CONVERSATION_RETENTION_STALE');
    let rows;
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(body.subarray(0, bytes));
      rows = text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
    } catch { throw fail('CONVERSATION_RETENTION_CORRUPT'); }
    if (rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw fail('CONVERSATION_RETENTION_CORRUPT');
    return { rows, bytes };
  } finally { closeSync(fd); }
}

/** Internal raw history for a caller-owned conversation set. The caller holds the guard until commit. */
export function acquireMessageRetentionGuard(indexFile, convFile, ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 256 || new Set(ids).size !== ids.length
    || ids.some(id => typeof id !== 'string' || !ID.test(id))) throw fail('CONVERSATION_RETENTION_SCOPE_INVALID');
  const lock = `${indexFile}.lock`;
  try { mkdirSync(lock); }
  catch (error) { if (error.code === 'EEXIST') throw fail('CONVERSATION_RETENTION_BUSY'); throw error; }
  let released = false, lockIdentity;
  const release = () => {
    if (released) return;
    released = true;
    if (lockIdentity === undefined || identity(lock) === lockIdentity) rmSync(lock, { recursive: true, force: true });
  };
  try {
    lockIdentity = identity(lock);
    const versions = new Map([[indexFile, identity(indexFile)]]);
    const index = readRows(indexFile, LIMIT, false);
    let remaining = LIMIT - index.bytes;
    const wanted = new Set(ids), metadata = new Map();
    for (const row of index.rows) {
      if (!wanted.has(row.id)) continue;
      if (metadata.has(row.id)) throw fail('CONVERSATION_RETENTION_CORRUPT');
      metadata.set(row.id, row);
    }
    const histories = new Map();
    for (const id of [...ids].sort()) {
      const meta = metadata.get(id);
      if (!meta) throw fail('CONVERSATION_RETENTION_MISSING');
      for (const key of ['contentRevision', 'messageCount']) {
        if (meta[key] !== undefined && (!Number.isSafeInteger(meta[key]) || meta[key] < 0)) throw fail('CONVERSATION_RETENTION_CORRUPT');
      }
      const file = convFile(id);
      versions.set(file, identity(file));
      const history = readRows(file, remaining, meta.messageCount === 0 && meta.contentRevision === 0);
      remaining -= history.bytes;
      if (meta.messageCount !== undefined && history.rows.length !== meta.messageCount) throw fail('CONVERSATION_RETENTION_CORRUPT');
      histories.set(id, history.rows);
    }
    const assertCurrent = () => {
      try { return !released && lockIdentity !== null && identity(lock) === lockIdentity && [...versions].every(([file, version]) => identity(file) === version); }
      catch { return false; }
    };
    if (!assertCurrent()) throw fail('CONVERSATION_RETENTION_STALE');
    const revision = `sha256:${createHash('sha256').update(JSON.stringify([[...ids].sort(), ...versions.values()])).digest('hex')}`;
    return { histories, revision, assertCurrent, release };
  } catch (error) { release(); throw error; }
}
