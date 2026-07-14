import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GoalPlan, GoalPlanStatus } from '@peer-agent/protocol';
import {
  hasPendingGoalApproval,
  selectPrimaryGoalPlan,
  shouldDefaultExpandGoalPlan,
} from './goalPlanExpansion.ts';

function plan(status: GoalPlanStatus, planId: string = status): GoalPlan {
  return { planId, status } as GoalPlan;
}

describe('goal plan default expansion', () => {
  it('locks the bar open while any plan is awaiting approval', () => {
    assert.equal(
      hasPendingGoalApproval([plan('executing'), plan('awaiting_approval')]),
      true,
    );
    assert.equal(
      hasPendingGoalApproval([plan('executing'), plan('completed')]),
      false,
    );
  });

  it('does not treat an accepted self-driven goal as pending approval', () => {
    const acceptedGoal = {
      ...plan('accepted', 'accepted-goal'),
      workflowKind: 'goal_self_driven' as const,
    };
    assert.equal(hasPendingGoalApproval([acceptedGoal]), false);
    assert.equal(hasPendingGoalApproval([plan('accepted')]), false);
  });

  it('expands every non-terminal plan that can still require attention', () => {
    const activeStatuses: GoalPlanStatus[] = [
      'drafting',
      'awaiting_approval',
      'approved',
      'accepted',
      'executing',
      'paused',
      'failed',
    ];

    for (const status of activeStatuses) {
      assert.equal(
        shouldDefaultExpandGoalPlan(plan(status)),
        true,
        `${status} should start expanded`,
      );
    }
  });

  it('collapses completed and cancelled history by default', () => {
    for (const status of ['completed', 'cancelled'] as const) {
      assert.equal(
        shouldDefaultExpandGoalPlan(plan(status)),
        false,
        `${status} should start collapsed`,
      );
    }
  });

  it('selects an accepted plan when no approval or execution plan exists', () => {
    const accepted = plan('accepted', 'accepted-plan');
    assert.equal(
      selectPrimaryGoalPlan([plan('completed'), accepted])?.planId,
      accepted.planId,
    );
  });

  it('keeps approval and execution plans ahead of other active plans', () => {
    const plans = [
      plan('accepted'),
      plan('executing'),
      plan('awaiting_approval'),
    ];
    assert.equal(selectPrimaryGoalPlan(plans)?.status, 'awaiting_approval');
    assert.equal(
      selectPrimaryGoalPlan([plans[0], plans[1]])?.status,
      'executing',
    );
  });

  it('returns no primary plan when only terminal history remains', () => {
    assert.equal(
      selectPrimaryGoalPlan([plan('completed'), plan('cancelled')]),
      null,
    );
  });
});
