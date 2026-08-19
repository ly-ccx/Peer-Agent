import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GoalPlan } from '@peer-agent/protocol';
import { orderGoalPlansByLineage } from './goalPlanOrder.ts';

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

const ids = (plans: readonly GoalPlan[]) => plans.map((item) => item.planId);

describe('orderGoalPlansByLineage', () => {
  it('orders descendants right after their parent while preserving sibling order', () => {
    const plans = [plan('child-b', 'parent'), plan('other'), plan('parent'), plan('child-a', 'parent'), plan('grandchild', 'child-a')];

    assert.deepEqual(ids(orderGoalPlansByLineage(plans)), ['other', 'parent', 'child-b', 'child-a', 'grandchild']);
  });

  it('keeps orphaned historical goals visible', () => {
    const child = plan('child', 'parent');
    const orphan = plan('orphan', 'missing');

    assert.deepEqual(ids(orderGoalPlansByLineage([child, orphan])), ['child', 'orphan']);
  });

  it('does not hide cyclic malformed historical relationships', () => {
    const first = plan('first', 'second');
    const second = plan('second', 'first');

    assert.deepEqual(ids(orderGoalPlansByLineage([first, second])), ['first', 'second']);
  });
});
