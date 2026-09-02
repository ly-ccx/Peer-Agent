import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPageItems } from './marketplace-pagination.ts';

function pagesOf(items: ReturnType<typeof buildPageItems> | undefined) {
  return (items ?? []).map((item) => (item.type === 'page' ? item.page : '…'));
}

test('keeps every page when the range is short', () => {
  assert.deepEqual(pagesOf(buildPageItems(1, 1)), [1]);
  assert.deepEqual(pagesOf(buildPageItems(3, 5)), [1, 2, 3, 4, 5]);
});

test('pins first and last pages and keeps a window around the current page', () => {
  assert.deepEqual(pagesOf(buildPageItems(10, 312)), [1, '…', 8, 9, 10, 11, 12, '…', 312]);
  assert.deepEqual(pagesOf(buildPageItems(1, 312)), [1, 2, 3, '…', 312]);
  assert.deepEqual(pagesOf(buildPageItems(312, 312)), [1, '…', 310, 311, 312]);
});

test('does not insert an ellipsis when the window already touches the edge', () => {
  assert.deepEqual(pagesOf(buildPageItems(4, 20)), [1, 2, 3, 4, 5, 6, '…', 20]);
  assert.deepEqual(pagesOf(buildPageItems(18, 20)), [1, '…', 16, 17, 18, 19, 20]);
});

test('clamps invalid current/total values to a usable first page', () => {
  assert.deepEqual(pagesOf(buildPageItems(0, 0)), [1]);
  assert.deepEqual(pagesOf(buildPageItems(-3, 8)), [1, 2, 3, '…', 8]);
  assert.deepEqual(pagesOf(buildPageItems(99, 8)), [1, '…', 6, 7, 8]);
});
