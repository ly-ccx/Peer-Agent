import { lstatSync, mkdirSync, rmdirSync } from 'node:fs';
import path from 'node:path';
const wait = new Int32Array(new SharedArrayBuffer(4));

/** Same empty-directory Store lock as native Rust. Never reclaim by age or PID. */
export function withStoreFileLock(file, operation) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`, deadline = performance.now() + 100;
  while (true) {
    try { mkdirSync(lock, { mode: 0o700 }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (performance.now() >= deadline) throw Object.assign(Error('Store lock is busy'), { code: 'STORE_LOCK_BUSY' });
      Atomics.wait(wait, 0, 0, 5);
    }
  }
  const held = lstatSync(lock, { bigint: true });
  try { return operation(); }
  finally {
    const current = lstatSync(lock, { bigint: true });
    if (!current.isDirectory() || current.dev !== held.dev || current.ino !== held.ino || current.ctimeNs !== held.ctimeNs) {
      throw Object.assign(Error('Store lock ownership changed'), { code: 'STORE_LOCK_OWNERSHIP_CHANGED' });
    }
    // Unknown lock bodies/replacement owners are retained for offline recovery.
    rmdirSync(lock);
  }
}
