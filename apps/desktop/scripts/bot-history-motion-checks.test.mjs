import assert from 'node:assert/strict';
import test from 'node:test';
import { disclosureHeightSnapped } from './disclosure-height-sample.mjs';

test('a late screencast sample is not a disclosure snap, and one frame still cannot cross the disclosure', () => {
  const stalled = [
    { at: 270, height: 37.546875 },
    { at: 418, height: 108.15625 },
    { at: 452, height: 117.375 },
  ];
  assert.equal(disclosureHeightSnapped(stalled), false);
  const span = 85.375;
  assert.equal(disclosureHeightSnapped([
    { at: 0, height: 32 },
    { at: 16, height: 32 + span },
  ]), true);
});
