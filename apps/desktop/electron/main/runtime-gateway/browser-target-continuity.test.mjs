import assert from 'node:assert/strict';
import test from 'node:test';
import { browserTargetContinuity } from './browser-target-continuity.mjs';
const native = { surface: 'native', webContentsId: 9, windowId: 'w', generation: 'g' };
test('native identity is pinned across async reveal, including failure and target change', () => {
  assert.deepEqual(browserTargetContinuity({ captured: native, current: native, reveal: { windowId: 'w', generation: 'g' } }), { pinned: true });
  assert.equal(browserTargetContinuity({ captured: native, current: native, revealFailure: true }).reason, 'browser_instance_unavailable');
  for (const current of [null, { ...native, generation: 'new' }, { surface: 'embedded', webContentsId: 10 }]) {
    assert.equal(browserTargetContinuity({ captured: native, current }).reason, 'browser_target_changed');
  }
  assert.equal(browserTargetContinuity({ captured: native, current: { ...native, available: false } }).reason, 'browser_instance_unavailable');
});
test('embedded compatibility is retained; a native handoff receipt cannot bind another generation', () => {
  assert.deepEqual(browserTargetContinuity({ captured: {}, current: {}, revealFailure: true }), { pinned: false });
  assert.equal(browserTargetContinuity({ current: native, reveal: { windowId: 'w', generation: 'old' } }).reason, 'browser_target_changed');
});
