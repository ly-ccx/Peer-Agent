import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  effortIndexForLevel,
  effortIndexFromValue,
  effortLevelForDisplay,
  snapEffortValue,
} from './effortSlider.ts';

describe('reasoning effort slider', () => {
  it('uses the persisted effort for idle display and the slider value only while previewing', () => {
    const levels = ['off', 'low', 'default', 'high', 'xhigh', 'max'] as const;
    assert.equal(effortLevelForDisplay('xhigh', levels, 100, false), 'xhigh');
    assert.equal(effortLevelForDisplay('xhigh', levels, 100, true), 'max');
    assert.equal(effortLevelForDisplay('max', levels, 80, false), 'max');
  });

  it('keeps persisted xhigh/max near the strongest available level instead of falling back to off', () => {
    assert.equal(effortIndexForLevel('xhigh', ['off', 'low', 'default', 'high']), 3);
    assert.equal(effortIndexForLevel('max', ['off', 'low', 'default', 'high', 'xhigh']), 4);
    assert.equal(effortIndexForLevel('xhigh', ['off', 'low', 'default', 'high', 'xhigh']), 4);
    assert.equal(effortIndexForLevel('off', ['off', 'low', 'default', 'high']), 0);
  });

  it('maps a continuous drag position to dynamic model levels', () => {
    assert.equal(effortIndexFromValue(0, 5), 0);
    assert.equal(effortIndexFromValue(24, 5), 1);
    assert.equal(effortIndexFromValue(51, 5), 2);
    assert.equal(effortIndexFromValue(88, 5), 4);
    assert.equal(effortIndexFromValue(80, 3), 2);
  });

  it('snaps release positions to the nearest available level', () => {
    assert.equal(snapEffortValue(12, 5), 0);
    assert.equal(snapEffortValue(13, 5), 25);
    assert.equal(snapEffortValue(62, 5), 50);
    assert.equal(snapEffortValue(63, 5), 75);
    assert.equal(snapEffortValue(74, 3), 50);
    assert.equal(snapEffortValue(76, 3), 100);
  });
});
