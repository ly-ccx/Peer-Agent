/** Bounded derived values only; strict history and file versions remain authoritative. */
export function createHistoryProjectionReader({ describe, load, project, maxEntries = 32, maxBytes = 8 * 1024 * 1024 }) {
  const entries = new Map(); let bytes = 0;
  const drop = id => { const row = entries.get(id); if (row) bytes -= row.bytes; entries.delete(id); };
  const attempt = id => {
    let description;
    try { description = describe(id); }
    catch (error) { drop(id); throw error; }
    if (!description) { drop(id); return null; }
    const cached = entries.get(id);
    if (cached?.version === description.version) {
      entries.delete(id); entries.set(id, cached);
      return structuredClone(cached.value);
    }
    drop(id);
    let value;
    try { value = structuredClone(project({ ...load(description), createdAt: description.createdAt })); }
    catch (error) {
      if (describe(id)?.version !== description.version) throw Object.assign(new Error('BACKGROUND_VERSION_CHANGED', { cause: error }), { code: 'BACKGROUND_VERSION_CHANGED' });
      throw error;
    }
    if (describe(id)?.version !== description.version) throw Object.assign(new Error('BACKGROUND_VERSION_CHANGED'), { code: 'BACKGROUND_VERSION_CHANGED' });
    const size = Buffer.byteLength(JSON.stringify(value) ?? 'null');
    if (maxEntries > 0 && size <= maxBytes) {
      entries.set(id, { version: description.version, value, bytes: size }); bytes += size;
      while (entries.size > maxEntries || bytes > maxBytes) drop(entries.keys().next().value);
    }
    return structuredClone(value);
  };
  return id => {
    for (let count = 0; ; count++) {
      try { return attempt(id); }
      catch (error) { if (error.code !== 'BACKGROUND_VERSION_CHANGED' || count === 2) throw error; }
    }
  };
}
