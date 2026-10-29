import assert from 'node:assert/strict';
import test from 'node:test';
import { overlayCloseTarget } from './overlayCloseTarget.ts';

test('a centered modal converges to the measured footer rectangle', () => {
  assert.deepEqual(overlayCloseTarget({ left: 410, top: 170, width: 460, height: 440 },
    { left: 170, top: 744, width: 92, height: 22 }), {
    '--motion-target-x': '-240px', '--motion-target-y': '574px',
    '--motion-target-scale-x': 0.2, '--motion-target-scale-y': 0.05,
  });
});

test('missing or invalid target geometry retains ordinary dismissal', () => {
  const source = { left: 0, top: 0, width: 460, height: 440 };
  assert.equal(overlayCloseTarget(source, { left: 0, top: 0, width: 0, height: 20 }), undefined);
  assert.equal(overlayCloseTarget(source, { left: NaN, top: 0, width: 90, height: 20 }), undefined);
});
