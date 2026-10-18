import { Worker } from 'node:worker_threads';
import { readFileSync, statSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export const conversationFileVersion = file => {
  const info = statSync(file, { bigint: true });
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
};
const errorFor = (code, message = code) => Object.assign(new Error(message), { code });
let active = 0;
const waiting = [];
function prepare(input, timeoutMs) {
  if (waiting.length >= 64) return Promise.reject(errorFor('CONVERSATION_COMMIT_QUEUE_FULL'));
  return new Promise((resolve, reject) => {
    let worker, timer, settled = false, started = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (!started) { const index = waiting.indexOf(start); if (index >= 0) waiting.splice(index, 1); reject(error); return; }
      Promise.resolve(worker?.terminate()).catch(() => {}).then(() => {
        active--; pump();
        if (error) reject(error); else resolve(value);
      });
    };
    const start = () => {
      started = true; active++;
      try {
        // Static packaged source supports ASAR without unpacking or evaluating model content.
        const source = readFileSync(new URL('./terminal-message-worker.cjs', import.meta.url), 'utf8');
        worker = new Worker(source, { eval: true, workerData: input });
        worker.once('message', value => finish(value.ok ? null : errorFor(value.code, value.message), value));
        worker.once('error', error => finish(error));
        worker.once('exit', code => { if (!settled) finish(errorFor('CONVERSATION_COMMIT_WORKER_EXIT', `worker exit ${code}`)); });
      } catch (error) { finish(error); }
    };
    waiting.push(start);
    timer = setTimeout(() => finish(errorFor('CONVERSATION_COMMIT_TIMEOUT')), timeoutMs);
    pump();
  });
}
function pump() { while (active < 2 && waiting.length) waiting.shift()(); }

/** Prepare full history off-thread; only a validated small receipt enters the commit callback. */
export function createTerminalMessageCommitter({ storeDir, commitPrepared, timeoutMs = 30000, maxConflicts = 4 }) {
  const conversations = new Map();
  let pending = 0;
  function commit(id, messageId, patch) {
    if (!id || !messageId || !patch || typeof patch !== 'object') return Promise.reject(errorFor('CONVERSATION_COMMIT_INVALID'));
    if (pending >= 64) return Promise.reject(errorFor('CONVERSATION_COMMIT_QUEUE_FULL'));
    const frozenPatch = structuredClone(patch), deadline = Date.now() + timeoutMs;
    pending++;
    const previous = conversations.get(id) || Promise.resolve();
    const result = previous.catch(() => {}).then(async () => {
      const historyFile = join(storeDir, `${id}.jsonl`);
      for (let attempt = 0; attempt <= maxConflicts; attempt++) {
        const temporaryFile = `${historyFile}.${process.pid}.${randomUUID()}.tmp`;
        try {
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw errorFor('CONVERSATION_COMMIT_TIMEOUT');
          const prepared = await prepare({ historyFile, temporaryFile, messageId, patch: frozenPatch }, remaining);
          const result = await commitPrepared({ ...prepared, id, messageId, historyFile, temporaryFile });
          if (result !== false) return result;
        } catch (error) {
          if (error.code !== 'CONVERSATION_COMMIT_CONFLICT' || attempt === maxConflicts) throw error;
        } finally { try { unlinkSync(temporaryFile); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
      }
      throw errorFor('CONVERSATION_COMMIT_CONFLICT');
    });
    conversations.set(id, result);
    const release = () => { pending--; if (conversations.get(id) === result) conversations.delete(id); };
    result.then(release, release);
    return result;
  }
  return { commit, drain: () => Promise.allSettled([...conversations.values()]) };
}
