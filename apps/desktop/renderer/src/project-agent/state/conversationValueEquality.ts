/** IPC values are acyclic data. Compare fields without serializing large tool/text strings again. */
export function conversationValuesEqual(a: unknown, b: unknown, depth = 0): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || depth > 64) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.keys(a), right = Object.keys(b);
  return left.length === right.length && left.every(key => Object.hasOwn(b, key)
    && conversationValuesEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], depth + 1));
}
