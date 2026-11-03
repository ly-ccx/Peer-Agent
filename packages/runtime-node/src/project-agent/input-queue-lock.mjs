import { randomUUID } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from '../sqlite/connection.mjs';

const LOCK_STALE_MS = 10_000;
const wait = new Int32Array(new SharedArrayBuffer(4));
const busy = () => Object.assign(Error('Input queue lock is busy'), { code: 'EEXIST' });

function gateIdentity(file) {
  const stat = lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.nlink !== 1n) throw Error('INPUT_QUEUE_LOCK_UNAVAILABLE');
  return `${stat.dev}:${stat.ino}`;
}

function acquireGate(file, deadline) {
  try { closeSync(openSync(file, 'wx', 0o600)); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const identity = gateIdentity(file), db = new DatabaseSync(file);
  const current = () => {
    try { return gateIdentity(file) === identity; } catch { return false; }
  };
  try {
    db.exec('PRAGMA busy_timeout=0');
    while (true) {
      try { db.exec('BEGIN IMMEDIATE'); break; }
      catch (error) {
        if (![5, 6].includes(Number(error.errcode) & 255) && !['SQLITE_BUSY', 'SQLITE_LOCKED'].includes(error.code)) throw error;
        if (Date.now() >= deadline) throw busy();
        Atomics.wait(wait, 0, 0, 5);
      }
    }
    if (!current()) throw Error('INPUT_QUEUE_LOCK_UNAVAILABLE');
    return { current, release() { try { db.exec('ROLLBACK'); } finally { db.close(); } } };
  } catch (error) { db.close(); throw error; }
}

/** Current writers share a crash-released mutex and still honor the old directory lock. */
export function acquireInputQueueLock(queueFile, waitMs) {
  const lock = `${queueFile}.lock`;
  mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + waitMs;
  const gate = acquireGate(`${lock}.sqlite`, deadline);
  const ownerFile = path.join(lock, 'owner.json');
  const identity = () => {
    const stat = statSync(lock, { bigint: true });
    return `${stat.dev}:${stat.ino}`;
  };
  const reclaimable = () => {
    let owner;
    try { owner = JSON.parse(readFileSync(ownerFile, 'utf8')); } catch {}
    if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) return Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS;
    try { process.kill(owner.pid, 0); return false; }
    catch (error) { return error?.code === 'ESRCH'; }
  };
  try {
    while (true) {
      try { mkdirSync(lock); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          const observed = identity();
          if (reclaimable() && identity() === observed && reclaimable()) {
            rmSync(lock, { recursive: true, force: true });
            continue;
          }
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (Date.now() >= deadline) throw error;
        Atomics.wait(wait, 0, 0, 5);
      }
    }
    const held = identity(), owner = JSON.stringify({ pid: process.pid, token: randomUUID() });
    try { writeFileSync(ownerFile, owner); }
    catch (error) {
      try { if (identity() === held) rmSync(lock, { recursive: true, force: true }); } catch {}
      throw error;
    }
    let released = false;
    const ownsDirectory = () => {
      try { return identity() === held && readFileSync(ownerFile, 'utf8') === owner; } catch { return false; }
    };
    const current = () => !released && gate.current() && ownsDirectory();
    if (!current()) throw Error('INPUT_QUEUE_CHANGED');
    return { current, release() {
      if (released) return;
      released = true;
      try { if (ownsDirectory()) rmSync(lock, { recursive: true, force: true }); }
      finally { gate.release(); }
    } };
  } catch (error) { gate.release(); throw error; }
}
