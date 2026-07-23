import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildProcessingSummary, calculateToolWallClockMs } from './processingSummary.ts';
import type { SegmentGroup, ToolCallLegacy } from './types.ts';

describe('buildProcessingSummary', () => {
  it('labels a completed turn duration as total time', () => {
    assert.equal(buildProcessingSummary([], 51_000, false, true), '总耗时 51s');
    assert.equal(buildProcessingSummary([], 51_000, false, false), 'Total time 51s');
  });

  it('does not present an in-progress turn as completed', () => {
    assert.equal(buildProcessingSummary([], 51_000, true, true), '正在思考');
    assert.equal(buildProcessingSummary([], 51_000, true, false), 'Thinking');
  });

  it('shows de-duplicated tool wall-clock time', () => {
    const tools: ToolCallLegacy[] = [
      { tool: 'a', args: {}, startedAtMs: 1_000, endedAtMs: 6_000, durationMs: 5_000 },
      { tool: 'b', args: {}, startedAtMs: 3_000, endedAtMs: 8_000, durationMs: 5_000 },
      { tool: 'c', args: {}, startedAtMs: 10_000, endedAtMs: 12_000, durationMs: 2_000 },
    ];
    const groups: SegmentGroup[] = [{ type: 'tool-call-group', calls: tools }];
    assert.equal(calculateToolWallClockMs(tools), 9_000);
    assert.equal(buildProcessingSummary(groups, 51_000, false, true), '总耗时 51s · 工具 9.0s');
  });

  it('ignores running and legacy duration-only calls in wall-clock aggregation', () => {
    const tools: ToolCallLegacy[] = [
      { tool: 'running', args: {}, startedAtMs: 1_000 },
      { tool: 'legacy', args: {}, durationMs: 4_000 },
    ];
    assert.equal(calculateToolWallClockMs(tools), 0);
  });
});
