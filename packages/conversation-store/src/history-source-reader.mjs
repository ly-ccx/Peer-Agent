const changed = () => Object.assign(new Error('BACKGROUND_VERSION_CHANGED'), { code: 'BACKGROUND_VERSION_CHANGED' });

function freeze(value) {
  const pending = [value];
  while (pending.length) {
    const next = pending.pop();
    if (!next || typeof next !== 'object' || Object.isFrozen(next)) continue;
    Object.freeze(next);
    for (const child of Object.values(next)) pending.push(child);
  }
  return value;
}

/** One strictly versioned parse per Store, shared by explicit, version-checked history projections.
 * Default callbacks receive a copy. Explicit immutable consumers share frozen input.
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
      freeze(value);
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
