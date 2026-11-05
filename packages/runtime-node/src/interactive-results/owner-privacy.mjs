import { encode, problem } from './storage.mjs';

const levels = ['D0_public', 'D1_internal', 'D2_sensitive', 'D3_private', 'D4_regulated'];
export function maximumInteractiveDataLevel(...values) {
  if (!values.length || values.some(value => !levels.includes(value))) throw problem('material_classification_unavailable');
  return levels[Math.max(...values.map(value => levels.indexOf(value)))];
}

/** Conservative owner context classification, never a content access/admission grant. */
export function createOwnerPrivacy(storage) {
  function known(context, owner) {
    const key = encode(owner), row = context.db.prepare('SELECT dataLevel FROM owner_privacy WHERE owner=?').get(key);
    if (row) return maximumInteractiveDataLevel(row.dataLevel);
    const facts = context.db.prepare('SELECT (SELECT COUNT(*) FROM materials WHERE owner=?) + (SELECT COUNT(*) FROM versions WHERE owner=?) AS count').get(key, key);
    if (Number(facts.count) > 0) throw problem('material_classification_unavailable');
    return null;
  }
  return {
    has(owner) {
      const context = storage.connect(owner.workspaceId);
      return !!context && known(context, owner) !== null;
    },
    current(owner, minimum) {
      maximumInteractiveDataLevel(minimum);
      const context = storage.connect(owner.workspaceId);
      const saved = context && known(context, owner);
      return saved ? maximumInteractiveDataLevel(saved, minimum) : minimum;
    },
    remember(context, owner, dataLevel) {
      const previous = known(context, owner);
      const next = previous ? maximumInteractiveDataLevel(previous, dataLevel) : maximumInteractiveDataLevel(dataLevel);
      if (previous === next) return;
      context.db.prepare('INSERT INTO owner_privacy VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET dataLevel=excluded.dataLevel').run(encode(owner), next);
    },
  };
}
