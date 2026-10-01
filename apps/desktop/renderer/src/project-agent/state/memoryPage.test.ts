import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryPage } from './memoryPage.ts';
const all = { kind: '', trust: '', status: '' };

test('large memory results stay bounded, page through every identity, and filter before pagination', () => {
  const items = Array.from({ length: 10000 }, (_, i) => ({ id: String(i), text: `record ${i}`, kind: i % 2 ? 'fact' : 'preference', trust: 'stated', status: 'active', pinned: false }));
  const first = memoryPage(items, all, 0);
  assert.equal(first.total, 10000); assert.equal(first.pages, 200); assert.equal(first.items.length, 50);
  assert.equal(first.start, 1); assert.equal(first.end, 50);
  const seen = Array.from({ length: 200 }, (_, page) => memoryPage(items, all, page).items).flat();
  assert.deepEqual(seen, items); assert.equal(new Set(seen.map(item => item.id)).size, 10000);
  const filtered = memoryPage(items, { ...all, kind: 'fact' }, 99);
  assert.equal(filtered.total, 5000); assert.equal(filtered.items.length, 50);
  assert.equal(filtered.items.at(-1)?.id, '9999');
  assert.equal(memoryPage(items, all, 999).page, 199);
  assert.equal(memoryPage(items, all, -1).page, 0);
  assert.equal(memoryPage(items, all, Number.NaN).page, 0);
  assert.equal(items.length, 10000);
});

test('deletion clamps the final page and empty filters expose zero results', () => {
  const items = [{ id: 'kept', text: 'record', kind: 'fact', trust: 'verified', status: 'active', pinned: false }];
  assert.equal(memoryPage(items, all, 199).page, 0);
  const empty = memoryPage(items, { ...all, status: 'forgotten' }, 5);
  assert.deepEqual(empty.items, []); assert.equal(empty.total, 0); assert.equal(empty.start, 0); assert.equal(empty.end, 0);
  assert.equal(empty.page, 0); assert.equal(empty.pages, 0);
});
