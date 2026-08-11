import { describe, expect, test } from 'bun:test';

import { createBoundedTextCache } from './bounded-text-cache.ts';

describe('bounded text cache', () => {
  test('returns values and promotes hits to most recently used', () => {
    const cache = createBoundedTextCache<number>({ maxEntries: 2, maxKeyChars: 20, maxTotalKeyChars: 40 });
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1);
    cache.set('c', 3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
  });

  test('rejects oversized keys without evicting useful entries', () => {
    const cache = createBoundedTextCache<number>({ maxEntries: 2, maxKeyChars: 3, maxTotalKeyChars: 6 });
    cache.set('abc', 1);
    cache.set('oversized', 2);
    expect(cache.get('abc')).toBe(1);
    expect(cache.get('oversized')).toBeUndefined();
    expect(cache.stats().entries).toBe(1);
  });

  test('evicts until the total character budget is restored', () => {
    const cache = createBoundedTextCache<number>({ maxEntries: 10, maxKeyChars: 10, maxTotalKeyChars: 5 });
    cache.set('aaa', 1);
    cache.set('bbb', 2);
    expect(cache.get('aaa')).toBeUndefined();
    expect(cache.get('bbb')).toBe(2);
    expect(cache.stats().totalKeyChars).toBe(3);
    expect(cache.stats().evictions).toBe(1);
  });
});
