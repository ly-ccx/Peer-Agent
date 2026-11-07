import assert from 'node:assert/strict';
import test from 'node:test';
import { disclosureHeightSnapped } from './disclosure-height-sample.mjs';

const span = 85.375;

test('a 148ms sample gap is not a one-frame snap, and a full-height jump still fails at any gap', () => {
  const recorded = [
    { at: 0, height: 32 },
    { at: 270, height: 37.546875 },
    { at: 418, height: 108.15625 },
    { at: 452, height: 32 + span },
  ];
  assert.equal(disclosureHeightSnapped(recorded), false);
  assert.equal(disclosureHeightSnapped([
    { at: 0, height: 32 },
    { at: 16, height: 32 + span },
  ]), true);
  assert.equal(disclosureHeightSnapped([
    { at: 0, height: 32 },
    { at: 148, height: 32 },
    { at: 164, height: 32 + span },
  ]), true);
  assert.equal(disclosureHeightSnapped([
    { at: 0, height: 32 },
    { at: 148, height: 32 + span },
  ]), true, 'a long gap does not excuse replacing the entire disclosure');
});
