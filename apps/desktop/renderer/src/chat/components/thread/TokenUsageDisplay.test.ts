import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  effortIndexForLevel,
  effortIndexFromValue,
  effortLevelForDisplay,
  snapEffortValue,
} from './effortSlider.ts';
import { resolveStickyContextDisplay } from './stickyContextDisplay.ts';

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


describe('resolveStickyContextDisplay', () => {
  it('keeps lastKnown percent/tokens when live values are temporarily unknown', async () => {
    assert.deepEqual(
      resolveStickyContextDisplay({
        livePercent: null,
        liveTokens: null,
        lastKnownPercent: 57,
        lastKnownTokens: 432_300,
      }),
      { percent: 57, tokens: 432_300 },
    );
  });

  it('prefers live values and only falls back to "?" when never measured', async () => {
    assert.deepEqual(
      resolveStickyContextDisplay({
        livePercent: 12,
        liveTokens: 1_000,
        lastKnownPercent: 57,
        lastKnownTokens: 432_300,
      }),
      { percent: 12, tokens: 1_000 },
    );
    assert.deepEqual(
      resolveStickyContextDisplay({
        livePercent: null,
        liveTokens: null,
        lastKnownPercent: null,
        lastKnownTokens: null,
      }),
      { percent: null, tokens: null },
    );
  });
});

