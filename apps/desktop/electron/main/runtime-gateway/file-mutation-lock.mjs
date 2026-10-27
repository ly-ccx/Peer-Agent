import { realpathSync } from 'node:fs';
import path from 'node:path';
const queues = new Map();
const problem = code => Object.assign(new Error(code), { code });
/** Host-local coordination only. A queue is never a permission or a cross-process filesystem lock. */
export function fileMutationKey(filePath) {
  const absolute = path.resolve(filePath);
  try { return realpathSync(absolute); }
  catch { try { return path.join(realpathSync(path.dirname(absolute)), path.basename(absolute)); } catch { return absolute; } }
}
export async function withFileMutationLock(filePath, run, { signal } = {}) {
  if (signal?.aborted) throw problem('FILE_MUTATION_CANCELLED');
  const key = fileMutationKey(filePath), entry = queues.get(key) ?? { tail: Promise.resolve(), count: 0 };
  if (entry.count >= 64 || !queues.has(key) && queues.size >= 256) throw problem('FILE_MUTATION_BUSY');
  entry.count++; queues.set(key, entry);
  let started = false;
  const pending = entry.tail.then(() => { started = true; if (signal?.aborted) throw problem('FILE_MUTATION_CANCELLED'); return run(); });
  entry.tail = pending.then(() => undefined, () => undefined);
  const release = () => { if (--entry.count === 0 && queues.get(key) === entry) queues.delete(key); };
  void pending.then(release, release);
  if (!signal) return pending;
  let onAbort;
  const interrupted = new Promise((_, reject) => { onAbort = () => { if (!started) reject(problem('FILE_MUTATION_CANCELLED')); }; signal.addEventListener('abort', onAbort, { once: true }); if (signal.aborted) onAbort(); });
  try { return await Promise.race([pending, interrupted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}
