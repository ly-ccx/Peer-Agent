import assert from 'node:assert/strict';
import test from 'node:test';
import { positionAnchoredOverlay } from './anchoredOverlay.ts';

test('anchored placement opens above a bottom entry', () => {
  assert.deepEqual(positionAnchoredOverlay(
    { left: 20, top: 600, bottom: 632 }, { width: 360, height: 400 }, { width: 1000, height: 700 },
  ), { left: 20, top: 192, maxWidth: 976, maxHeight: 676 });
});
test('anchored placement opens below when above has no room', () => {
  assert.equal(positionAnchoredOverlay(
    { left: 20, top: 20, bottom: 52 }, { width: 360, height: 400 }, { width: 1000, height: 700 },
  ).top, 60);
});
test('narrow viewport and oversized content retain a reachable boundary', () => {
  assert.deepEqual(positionAnchoredOverlay(
    { left: 280, top: 500, bottom: 532 }, { width: 360, height: 600 }, { width: 320, height: 400 },
  ), { left: 12, top: 12, maxWidth: 296, maxHeight: 376 });
});
test('offscreen anchor is clamped after viewport resizing', () => {
  const result = positionAnchoredOverlay(
    { left: -50, top: -100, bottom: -68 }, { width: 200, height: 200 }, { width: 800, height: 600 },
  );
  assert.equal(result.left, 12);
  assert.equal(result.top, 12);
});
