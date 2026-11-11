import test from 'node:test';
import assert from 'node:assert/strict';
import { profileClock } from './profile-clock.mjs';

test('profile clock includes marker child frames and retains a bounded offset interval', () => {
  const profile = { startTime: 1000000, nodes: [
    { id: 1, callFrame: { functionName: 'marker' }, children: [2] },
    { id: 2, callFrame: { functionName: 'clock' } },
  ], samples: [2, 2, 2], timeDeltas: [1000, 1000, 1000] };
  const result = profileClock(profile, [{ name: 'marker', start: 1100.5, end: 1103.5 }]);
  assert.equal(result.offsetMs, 100); assert.equal(result.uncertaintyMs, .5);
  assert.throws(() => profileClock(profile, [{ name: 'missing', start: 0, end: 10 }]), /not_sampled/);
  assert.throws(() => profileClock(profile, [{ name: 'marker', start: 0, end: 20 }]), /calibration_invalid/);
});
