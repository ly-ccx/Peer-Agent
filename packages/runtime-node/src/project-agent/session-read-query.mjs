/** A synchronous observation, never a transaction or a cache for execution authority. */
export function createSessionReadQuery() {
  let current = null;
  return {
    /** @template T @param {string} key @param {() => T} load @returns {T} */
    memo(key, load) {
      if (!current) return load();
      if (!current.has(key)) current.set(key, load());
      return current.get(key);
    },
    /** @template T @param {() => T} read @returns {T} */
    run(read) {
      const owner = !current;
      if (owner) current = new Map();
      try {
        const result = read();
        if (result && typeof result.then === 'function') throw new TypeError('session_read_query_must_be_synchronous');
        return result;
      } finally { if (owner) current = null; }
    },
  };
}
