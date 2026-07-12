import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GoalPlan } from '@peer-agent/protocol';
import { buildGoalPlanTreeRows, goalPlanTreeDepth } from './goalPlanTree.ts';

const plan = (planId: string, parentPlanId?: string): GoalPlan => ({
  planId,
  title: planId,
  goal: planId,
  status: 'draft',
  tasks: [],
  createdAt: 1,
  updatedAt: 1,
  ...(parentPlanId ? { parentPlanId } : {}),
} as unknown as GoalPlan);

describe('goalPlanTree', () => {
  it('groups descendants below their parent while preserving sibling order', () => {
    const plans = [plan('child-b', 'parent'), plan('other'), plan('parent'), plan('child-a', 'parent'), plan('grandchild', 'child-a')];

    assert.deepEqual(buildGoalPlanTreeRows(plans).map(({ plan, depth }) => [plan.planId, depth]), [
      ['other', 0],
      ['parent', 0],
      ['child-b', 1],
      ['child-a', 1],
      ['grandchild', 2],
    ]);
  });

  it('keeps orphaned historical goals visible and computes depth against the full plan set', () => {
    const parent = plan('parent');
    const child = plan('child', 'parent');
    const orphan = plan('orphan', 'missing');
    const plansById = new Map([parent, child, orphan].map((item) => [item.planId, item]));

    assert.deepEqual(buildGoalPlanTreeRows([child, orphan]).map(({ plan, depth }) => [plan.planId, depth]), [
      ['child', 0],
      ['orphan', 0],
    ]);
    assert.equal(goalPlanTreeDepth(child, plansById), 1);
  });

  it('does not hide cyclic malformed historical relationships', () => {
    const first = plan('first', 'second');
    const second = plan('second', 'first');

    assert.deepEqual(buildGoalPlanTreeRows([first, second]).map(({ plan }) => plan.planId), ['first', 'second']);
  });
});
