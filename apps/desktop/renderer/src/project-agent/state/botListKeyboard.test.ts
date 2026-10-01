import assert from 'node:assert/strict';
import test from 'node:test';
import { botListKey } from './botListKeyboard.ts';
test('list navigation clamps, exposes endpoints and opens only activation keys', () => {
  const ids = ['a', 'b', 'c'];
  assert.deepEqual(botListKey(ids, null, 'ArrowDown'), { id: 'a', open: false });
  assert.deepEqual(botListKey(ids, null, 'ArrowUp'), { id: 'c', open: false });
  assert.deepEqual(botListKey(ids, 'a', 'ArrowUp'), { id: 'a', open: false });
  assert.deepEqual(botListKey(ids, 'a', 'End'), { id: 'c', open: false });
  assert.deepEqual(botListKey(ids, 'c', 'Home'), { id: 'a', open: false });
  assert.deepEqual(botListKey(ids, 'b', ' '), { id: 'b', open: true });
  assert.deepEqual(botListKey(ids, 'b', 'Enter'), { id: 'b', open: true });
  assert.equal(botListKey([], null, 'Enter'), null);
  assert.equal(botListKey(ids, 'a', 'Tab'), null);
});
