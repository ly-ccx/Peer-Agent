import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  planStickToBottomScroll,
  shouldProbeTurnForScroll,
  type StickScrollAnchor,
} from './threadScrollAnchor.ts';

const anchor = (patch: Partial<StickScrollAnchor> = {}): StickScrollAnchor => ({
  turnId: 'turn-1',
  scrollTop: 800,
  scrollHeight: 1000,
  ...patch,
});

describe('stick-to-bottom without a hit test', () => {
  it('snaps to the bottom and probes once when there is no anchor yet', () => {
    const plan = planStickToBottomScroll({
      anchor: null,
      scrollHeight: 1000,
      clientHeight: 200,
      snap: false,
    });
    assert.equal(plan.scrollTop, 800);
    assert.equal(plan.probe, true);
  });

  it('adjusts scrollTop by the height delta and does not probe while following', () => {
    const plan = planStickToBottomScroll({
      anchor: anchor(),
      scrollHeight: 1240,
      clientHeight: 200,
      snap: false,
    });
    assert.equal(plan.scrollTop, 1040);
    assert.equal(plan.probe, false);
  });

  it('clamps a delta that would otherwise run past the new bottom', () => {
    const plan = planStickToBottomScroll({
      anchor: anchor({ scrollTop: 900 }),
      scrollHeight: 1100,
      clientHeight: 200,
      snap: false,
    });
    assert.equal(plan.scrollTop, 900);
    assert.equal(plan.probe, false);
  });

  it('snaps when the user explicitly returns to the bottom', () => {
    const plan = planStickToBottomScroll({
      anchor: anchor({ scrollTop: 120, scrollHeight: 1000 }),
      scrollHeight: 1300,
      clientHeight: 200,
      snap: true,
    });
    assert.equal(plan.scrollTop, 1100);
    assert.equal(plan.probe, true);
  });

  it('skips the turn probe when the scroll position did not change', () => {
    assert.equal(shouldProbeTurnForScroll({ anchoredScrollTop: 400, scrollTop: 400 }), false);
    assert.equal(shouldProbeTurnForScroll({ anchoredScrollTop: 400, scrollTop: 460 }), true);
    assert.equal(shouldProbeTurnForScroll({ anchoredScrollTop: null, scrollTop: 0 }), true);
  });
});
