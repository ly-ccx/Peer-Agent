/** Preserve unchanged read-model identities without serializing complete IPC snapshots. */
function equalFact(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  return keys.every(key => Object.hasOwn(b, key) && equalFact(a[key], b[key]));
}

export function reconcileFacts<T>(previous: readonly T[], incoming: readonly T[], identity: (row: T) => string): readonly T[] {
  const indexed = new Map(previous.map(row => [identity(row), row]));
  const next = incoming.map(row => {
    const old = indexed.get(identity(row));
    return old !== undefined && equalFact(old, row) ? old : row;
  });
  return next.length === previous.length && next.every((row, index) => row === previous[index]) ? previous : next;
}
