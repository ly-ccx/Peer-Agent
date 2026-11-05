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

/** Retry acquisition without holding any lock across a yield to synchronous writers. */
export async function withFileLocksAsync(files, operation, timeoutMs = 5000) {
  const locks = files.map(file => `${file}.lock`);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const acquired = [];
    try {
      for (const lock of locks) {
        mkdirSync(lock);
        acquired.push(lock);
      }
    } catch (error) {
      for (const lock of acquired.reverse()) rmSync(lock, { recursive: true, force: true });
      if (error.code !== 'EEXIST' || Date.now() >= deadline) throw error;
      await delay(5);
      continue;
    }
    try { return operation(); }
    finally { for (const lock of acquired.reverse()) rmSync(lock, { recursive: true, force: true }); }
  }
}
