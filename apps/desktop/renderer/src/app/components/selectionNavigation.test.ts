import assert from 'node:assert/strict';
import test from 'node:test';
import { selectionNavigation } from './selectionNavigation.ts';

test('arrow navigation skips disabled choices and wraps without selecting them', () => {
  const items = [{}, { disabled: true }, {}];
  assert.equal(selectionNavigation(items, 0, 'ArrowRight'), 2);
  assert.equal(selectionNavigation(items, 2, 'ArrowRight'), 0);
  assert.equal(selectionNavigation(items, 0, 'ArrowLeft'), 2);
  assert.equal(selectionNavigation(items, -1, 'ArrowUp', 'vertical'), 2);
  assert.equal(selectionNavigation(items, 0, 'Enter'), null);
});
test('Home/End, RTL and empty or unavailable groups have defined destinations', () => {
  assert.equal(selectionNavigation([{ disabled: true }, {}, {}], 2, 'Home'), 1);
  assert.equal(selectionNavigation([{}, {}, { disabled: true }], 0, 'End'), 1);
  assert.equal(selectionNavigation([{}, {}, {}], 1, 'ArrowLeft', 'horizontal', true), 2);
  assert.equal(selectionNavigation([], 0, 'ArrowRight'), null);
  assert.equal(selectionNavigation([{ disabled: true }], 0, 'Home'), null);
});
