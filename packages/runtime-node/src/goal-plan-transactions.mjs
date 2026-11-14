import path from 'node:path';
import { withStoreFileLock } from './store-file-lock.mjs';

/** One synchronous canonical Goal write domain, shared with the native Host.
 * Nested internal calls share this instance's transaction. External callbacks
 * run after unlocking, so a second store can re-enter without bypassing locks.
 */
export function createGoalPlanTransactions(storeDir) {
  const file = path.join(storeDir, 'index.jsonl');
  let depth = 0, callbacks = [];
  function run(operation) {
    if (depth > 0) return operation();
    let result, failure;
    try {
      result = withStoreFileLock(file, () => {
        depth++;
        try {
          const value = operation();
          if (value && typeof value.then === 'function') throw Object.assign(Error('Goal transaction must be synchronous'), { code: 'GOAL_ASYNC_TRANSACTION_UNSUPPORTED' });
          return value;
        } finally { depth--; }
      });
    } catch (error) { failure = error; }
    const pending = callbacks; callbacks = [];
    for (const callback of pending) callback();
    if (failure) throw failure;
    return result;
  }
  function afterCommit(callback) { if (depth > 0) callbacks.push(callback); else callback(); }
  /** @template {object} T
   * @param {T} api
   * @param {readonly (keyof T)[]} names
   * @returns {T}
   */
  function bind(api, names) {
    for (const name of names) {
      const operation = api[name];
      if (typeof operation !== 'function') throw Error(`Unknown Goal mutator: ${name}`);
      api[name] = (...args) => run(() => operation(...args));
    }
    return api;
  }
  return { run, afterCommit, bind };
}
