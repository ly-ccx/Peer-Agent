import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isMessageStructureRewritten,
  planThreadScrollAfterMessagesChange,
  shouldStickMessageRailToLatest,
} from './threadScrollPolicy.ts';

describe('thread scroll policy after compaction', () => {
  it('detects structure rewrite when message count drops', () => {
    assert.equal(isMessageStructureRewritten(120, 36), true);
    assert.equal(isMessageStructureRewritten(36, 37), false);
    assert.equal(isMessageStructureRewritten(36, 36), false);
  });

  it('resets virtual measurements and reaffirms bottom after rewrite when auto-scroll is on', () => {
    const plan = planThreadScrollAfterMessagesChange({
      previousCount: 120,
      nextCount: 36,
      shouldAutoScroll: true,
    });
    assert.deepEqual(plan, {
      stickToBottom: true,
      resetVirtualMeasurements: true,
      reaffirmFrames: 2,
    });
  });

  it('does not force bottom when user has scrolled away', () => {
    const plan = planThreadScrollAfterMessagesChange({
      previousCount: 120,
      nextCount: 36,
      shouldAutoScroll: false,
    });
    assert.deepEqual(plan, {
      stickToBottom: false,
      resetVirtualMeasurements: false,
      reaffirmFrames: 0,
    });
  });

  it('keeps light stick-to-bottom for streaming append without measurement reset', () => {
    const plan = planThreadScrollAfterMessagesChange({
      previousCount: 36,
      nextCount: 37,
      shouldAutoScroll: true,
    });
    assert.deepEqual(plan, {
      stickToBottom: true,
      resetVirtualMeasurements: false,
      reaffirmFrames: 0,
    });
  });

  it('sticks message rail to latest only when item count shrinks', () => {
    assert.equal(shouldStickMessageRailToLatest(40, 15), true);
    assert.equal(shouldStickMessageRailToLatest(15, 16), false);
    assert.equal(shouldStickMessageRailToLatest(0, 10), true);
    assert.equal(shouldStickMessageRailToLatest(5, 0), false);
  });
});
