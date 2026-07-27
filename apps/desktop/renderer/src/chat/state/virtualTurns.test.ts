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

  it('keeps the same window signature while scrollTop stays inside the same overscan window', () => {
    // 滚动路径上的契约：在「未跨过窗口边界条目」的微滚动里，start/end/padding/totalSize 必须稳定，
    // 这样 hook 才能把 scrollTop 留在 ref 而不 setState 整棵 ChatSurface。
    // 选在条目中部的 scrollTop，避免 overscan 远边刚好跨过下一个 estimate 边界。
    const estimateSize = 300;
    const base = {
      count: 80,
      viewportSize: 800,
      measuredSizes: new Map<number, number>(),
      estimateSize,
      overscanPx: 900,
    } as const;
    const midItemScrollTop = 30 * estimateSize + 50; // 9050，落在 index 30 中部
    const a = calculateVirtualTurnRange({ ...base, scrollTop: midItemScrollTop });
    const b = calculateVirtualTurnRange({ ...base, scrollTop: midItemScrollTop + 40 });

    assert.equal(a.startIndex, b.startIndex);
    assert.equal(a.endIndex, b.endIndex);
    assert.equal(a.paddingStart, b.paddingStart);
    assert.equal(a.paddingEnd, b.paddingEnd);
    assert.equal(a.totalSize, b.totalSize);
  });
});
