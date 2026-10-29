import { mkdirSync, rmSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

export function withFileLock(file, operation) {
  const lock = `${file}.lock`, deadline = Date.now() + 5000;
  while (true) {
    try { mkdirSync(lock); break; }
    catch (error) { if (error.code !== 'EEXIST' || Date.now() >= deadline) throw error; }
  }
  try { return operation(); }
  finally { rmSync(lock, { recursive: true, force: true }); }
}

/** Async terminal callers never spin the main thread while another writer owns a lock. */
export async function withFileLockAsync(file, operation, timeoutMs = 5000) {
  const lock = `${file}.lock`, deadline = Date.now() + timeoutMs;
  while (true) {
    try { mkdirSync(lock); break; }
    catch (error) {
      if (error.code !== 'EEXIST' || Date.now() >= deadline) throw error;
      await delay(5);
    }
  }
  try { return await operation(); }
  finally { rmSync(lock, { recursive: true, force: true }); }
}
