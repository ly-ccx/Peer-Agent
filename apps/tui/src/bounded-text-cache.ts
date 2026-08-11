export interface BoundedTextCacheOptions {
  readonly maxEntries: number;
  readonly maxKeyChars: number;
  readonly maxTotalKeyChars: number;
}

export interface BoundedTextCacheStats {
  readonly entries: number;
  readonly totalKeyChars: number;
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
}

export interface BoundedTextCache<Value> {
  get(key: string): Value | undefined;
  set(key: string, value: Value): void;
  clear(): void;
  stats(): BoundedTextCacheStats;
}

/**
 * Small LRU for deterministic text projections. It is intentionally bounded by
 * both entry count and source-text size so streaming revisions cannot grow it
 * without limit.
 */
export function createBoundedTextCache<Value>(options: BoundedTextCacheOptions): BoundedTextCache<Value> {
  const values = new Map<string, Value>();
  let totalKeyChars = 0;
  let hits = 0;
  let misses = 0;
  let evictions = 0;

  const removeOldest = (): void => {
    const oldest = values.keys().next().value as string | undefined;
    if (oldest === undefined) return;
    values.delete(oldest);
    totalKeyChars -= oldest.length;
    evictions += 1;
  };

  return {
    get(key: string): Value | undefined {
      const value = values.get(key);
      if (value === undefined) {
        misses += 1;
        return undefined;
      }
      hits += 1;
      values.delete(key);
      values.set(key, value);
      return value;
    },
    set(key: string, value: Value): void {
      if (key.length > options.maxKeyChars) return;
      if (values.has(key)) {
        values.delete(key);
        totalKeyChars -= key.length;
      }
      values.set(key, value);
      totalKeyChars += key.length;
      while (
        values.size > options.maxEntries
        || totalKeyChars > options.maxTotalKeyChars
      ) removeOldest();
    },
    clear(): void {
      values.clear();
      totalKeyChars = 0;
      hits = 0;
      misses = 0;
      evictions = 0;
    },
    stats: () => ({ entries: values.size, totalKeyChars, hits, misses, evictions }),
  };
}
