import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  calculateVirtualTurnRange,
  estimateVirtualTurnOffset,
} from './virtualTurns.ts';

describe('virtual chat turn range', () => {
  it('renders only a bounded window for a long conversation', () => {
    const range = calculateVirtualTurnRange({
      count: 200,
      scrollTop: 18_000,
      viewportSize: 900,
      measuredSizes: new Map(),
      estimateSize: 300,
      overscanPx: 600,
    });

    assert.ok(range.items.length < 20);
    assert.equal(range.totalSize, 60_000);
    assert.ok(range.paddingStart > 0);
    assert.ok(range.paddingEnd > 0);
    assert.equal(range.items[0]?.index, range.startIndex);
    assert.equal(range.items.at(-1)?.index, range.endIndex);
  });

  it('uses measured heights without changing the total scroll model', () => {
    const measured = new Map([[0, 100], [1, 700], [2, 200]]);
    const range = calculateVirtualTurnRange({
      count: 4,
      scrollTop: 650,
      viewportSize: 200,
      measuredSizes: measured,
      estimateSize: 300,
      overscanPx: 0,
    });

    assert.equal(range.totalSize, 1_300);
    assert.deepEqual(range.items.map((item) => [item.index, item.start, item.size]), [
      [1, 100, 700],
      [2, 800, 200],
    ]);
  });

  it('can force-mount a target outside the visible window for message navigation', () => {
    const range = calculateVirtualTurnRange({
      count: 100,
      scrollTop: 0,
      viewportSize: 600,
      measuredSizes: new Map(),
      estimateSize: 300,
      overscanPx: 300,
      forceIndex: 80,
    });

    assert.equal(range.startIndex, 80);
    assert.equal(range.endIndex, 80);
    assert.deepEqual(range.items.map((item) => item.index), [80]);
    assert.equal(range.paddingStart, 24_000);
    assert.equal(range.paddingEnd, 5_700);
  });

  it('estimates a stable offset from measured and fallback sizes', () => {
    assert.equal(
      estimateVirtualTurnOffset(3, 10, new Map([[0, 100], [2, 500]]), 300),
      900,
    );
  });

  it('handles empty conversations', () => {
    const range = calculateVirtualTurnRange({
      count: 0,
      scrollTop: 0,
      viewportSize: 600,
      measuredSizes: new Map(),
    });

    assert.deepEqual(range.items, []);
    assert.equal(range.totalSize, 0);
    assert.equal(range.endIndex, -1);
  });

  it('keeps the same window when scrollTop moves within the same turn range', () => {
    // Scrolling inside a single tall turn must not change the virtual window indices/padding,
    // so the hook can skip setState entirely and avoid re-rendering the whole ChatSurface.
    const baseInput = {
      count: 5,
      viewportSize: 600,
      measuredSizes: new Map<number, number>([[2, 2000]]),
      estimateSize: 300,
      overscanPx: 200,
    } as const;

    const early = calculateVirtualTurnRange({ ...baseInput, scrollTop: 1100 });
    const mid = calculateVirtualTurnRange({ ...baseInput, scrollTop: 1400 });
    const late = calculateVirtualTurnRange({ ...baseInput, scrollTop: 1600 });

    assert.deepEqual(early.items, mid.items);
    assert.deepEqual(mid.items, late.items);
    assert.equal(early.startIndex, late.startIndex);
    assert.equal(early.endIndex, late.endIndex);
    assert.equal(early.paddingStart, late.paddingStart);
    assert.equal(early.paddingEnd, late.paddingEnd);
    assert.equal(early.totalSize, late.totalSize);
  });

  it('produces consistent range after clearing stale measurements (conversation switch)', () => {
    // Simulate conversation switch: stale measured heights from conversation A must not
    // leak into conversation B. After clearing the map, the range should use pure estimates.
    const staleMeasurements = new Map<number, number>([
      [0, 50], [1, 900], [2, 30], [3, 1200], [4, 80],
    ]);

    const withStale = calculateVirtualTurnRange({
      count: 5,
      scrollTop: 0,
      viewportSize: 600,
      measuredSizes: staleMeasurements,
      estimateSize: 300,
      overscanPx: 200,
    });

    // After conversation switch, measurements are cleared.
    staleMeasurements.clear();

    const afterReset = calculateVirtualTurnRange({
      count: 5,
      scrollTop: 0,
      viewportSize: 600,
      measuredSizes: staleMeasurements,
      estimateSize: 300,
      overscanPx: 200,
    });

    // The total size must change: stale measurements had irregular heights, reset uses uniform estimates.
    assert.notEqual(withStale.totalSize, afterReset.totalSize);
    // After reset, total size should be count * estimateSize = 5 * 300 = 1500.
    assert.equal(afterReset.totalSize, 1500);
    // All items should have uniform estimated size.
    for (const item of afterReset.items) {
      assert.equal(item.size, 300);
    }
  });
});
