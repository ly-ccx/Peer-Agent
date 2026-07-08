export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const COMPACT_JSON_CHAR_LIMIT = 4000;
const COMPACT_JSON_PREVIEW_CHARS = 3200;

export function compactJson(value: unknown) {
  try {
    const text = JSON.stringify(value, null, 2);
    if (text.length <= COMPACT_JSON_CHAR_LIMIT) return text;
    return JSON.stringify({
      truncated: true,
      originalChars: text.length,
      preview: `${text.slice(0, COMPACT_JSON_PREVIEW_CHARS)}...`,
    }, null, 2);
  } catch {
    return String(value);
  }
}

export function compactLine(value: unknown) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

export function collectValuesByKey(
  value: unknown,
  key: string,
  output: Set<string>,
  seen = new WeakSet<object>(),
  depth = 0,
) {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((item) => collectValuesByKey(item, key, output, seen, depth + 1));
    return;
  }

  Object.entries(value as Record<string, unknown>).forEach(([entryKey, entryValue]) => {
    if (entryKey.toLowerCase() === key.toLowerCase()) {
      const text = compactLine(entryValue).trim();
      if (text) output.add(text);
    }
    collectValuesByKey(entryValue, key, output, seen, depth + 1);
  });
}

export function recordString(record: Record<string, unknown>, keys: readonly string[]) {
  for (const key of keys) {
    const value = compactLine(record[key]).trim();
    if (value) return value;
  }
  return '';
}

export function recordNumber(record: Record<string, unknown>, keys: readonly string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}
