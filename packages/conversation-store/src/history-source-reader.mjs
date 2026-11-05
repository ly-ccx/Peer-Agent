const changed = () => Object.assign(new Error('BACKGROUND_VERSION_CHANGED'), { code: 'BACKGROUND_VERSION_CHANGED' });

export function freezeHistoryValue(value, plainOnly = false) {
  const pending = [value];
  const visited = plainOnly ? new WeakSet() : null;
  while (pending.length) {
    const next = pending.pop();
    if (!next || typeof next !== 'object' && typeof next !== 'function') continue;
    if (plainOnly && !Array.isArray(next) && ![Object.prototype, null].includes(Object.getPrototypeOf(next))) {
      throw new TypeError('Immutable history projections require plain data');
    }
    if (typeof next !== 'object' || (visited ? visited.has(next) : Object.isFrozen(next))) continue;
    visited?.add(next);
    Object.freeze(next);
    for (const child of Object.values(next)) pending.push(child);
  }
  return value;
}

const FULL_HISTORY_LOADS = new Set([
  'readPersistedHistoryFiles',
  'getPersistedConversationHistory',
  'getPersistedConversationHistories',
  'getConversation',
  'readConversationYielding',
]);

/** List preview loaders must not be a full JSONL history read. */
export function assertListPreviewLoad(load) {
  if (typeof load !== 'function' || FULL_HISTORY_LOADS.has(load.name) || load.fullHistory === true) {
    throw Object.assign(new Error('LIST_HOT_PATH_FORBIDS_FULL_HISTORY'), { code: 'LIST_HOT_PATH_FORBIDS_FULL_HISTORY' });
  }
}

/**
 * Cache for list preview / tail reads. `load` is the cache-miss path and may
 * return a materialized preview or an index tail. It must not be a full history read.
 */
export function createListPreviewSource({ describe, load, maxEntries = 512 }) {
  assertListPreviewLoad(load);
  if (describe) assertListPreviewLoad(describe);
  const entries = new Map();
  return (id) => {
    const version = describe(id);
    if (version == null) {
      entries.delete(id);
      return null;
    }
    const cached = entries.get(id);
    if (cached && cached.version === version) {
      entries.delete(id);
      entries.set(id, cached);
      return cached.value;
    }
    const value = load(id);
    entries.set(id, { version, value });
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    return value;
  };
}

/** One strictly versioned parse per Store, shared by explicit, version-checked history projections.
 * Default callbacks receive a copy. Explicit immutable consumers share frozen input.
 * Not the list hot path: list previews use createListPreviewSource.
 */
export function createHistorySourceReader({ load, maxEntries = 8, maxBytes = 64 * 1024 * 1024 }) {
  const entries = new Map(); let bytes = 0;
  const drop = id => { const row = entries.get(id); if (row) bytes -= row.bytes; entries.delete(id); };
  return (description, { isCurrent, immutableInput = false }) => {
    const id = description.conversationId;
    const cached = entries.get(id);
    let value;
    if (cached?.version === description.version) {
      if (!isCurrent()) { drop(id); throw changed(); }
      entries.delete(id); entries.set(id, cached);
      value = cached.value;
    } else {
      drop(id);
      try { value = load(description); }
      catch (error) { if (!isCurrent()) throw changed(); throw error; }
      freezeHistoryValue(value);
      const size = Buffer.byteLength(JSON.stringify(value) ?? 'null');
      if (!isCurrent()) throw changed();
      if (maxEntries > 0 && size <= maxBytes) {
        entries.set(id, { version: description.version, value, bytes: size }); bytes += size;
        while (entries.size > maxEntries || bytes > maxBytes) drop(entries.keys().next().value);
      }
    }
    return immutableInput ? value : structuredClone(value);
  };
}
