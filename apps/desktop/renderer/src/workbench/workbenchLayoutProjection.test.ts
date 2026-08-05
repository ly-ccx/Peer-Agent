import assert from 'node:assert/strict';
import test from 'node:test';
import { workbenchIsLayoutVisible } from './workbenchLayoutProjection.ts';

test('Workbench only occupies a layout column while open on the active Chat page', () => {
  assert.equal(workbenchIsLayoutVisible(false, true), false);
  assert.equal(workbenchIsLayoutVisible(false, false), false);
  assert.equal(workbenchIsLayoutVisible(true, true), true);
  assert.equal(workbenchIsLayoutVisible(true, false), false);
});

test('leaving Chat releases the Workbench column without clearing the saved open state', () => {
  const open = true;
  const visibleAcrossNavigation = [
    workbenchIsLayoutVisible(open, true),
    workbenchIsLayoutVisible(open, false),
    workbenchIsLayoutVisible(open, true),
  ];

  assert.deepEqual(visibleAcrossNavigation, [true, false, true]);
  assert.equal(open, true);
});
