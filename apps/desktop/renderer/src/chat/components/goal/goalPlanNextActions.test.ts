import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GoalPlan } from '@peer-agent/protocol';
import { getGoalPlanNextStep, goalPlanNextStepCopy } from './goalPlanNextActions.ts';

function plan(overrides: Partial<GoalPlan>): GoalPlan {
  return {
    planId: 'plan-1',
    title: 'Next step test',
    goal: 'Show clear next steps',
    status: 'awaiting_approval',
    workflowKind: 'plan_approval',
    activation: { kind: 'approval_required' },
    tasks: [],
    progress: { total: 0, completed: 0, failed: 0, blocked: 0, percent: 0 },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as GoalPlan;
}

describe('goal plan next actions', () => {
  it('offers start, adjust and cancel for a plan awaiting approval', () => {
    assert.deepEqual(getGoalPlanNextStep(plan({}))?.actions, ['start', 'adjust', 'cancel']);
  });

  it('offers the same actions for an accepted goal before its runner starts', () => {
    const nextStep = getGoalPlanNextStep(plan({
      status: 'accepted',
      workflowKind: 'goal_self_driven',
      activation: { kind: 'accepted_goal' },
      runner: { enabled: false } as GoalPlan['runner'],
    }));
    assert.equal(nextStep?.kind, 'accepted_goal');
    assert.deepEqual(nextStep?.actions, ['start', 'adjust', 'cancel']);
  });

  it('does not show creation actions after execution begins', () => {
    assert.equal(getGoalPlanNextStep(plan({ status: 'executing' })), null);
  });

  it('keeps Chinese guidance explicit', () => {
    const copy = goalPlanNextStepCopy(true);
    assert.match(copy.guidance, /开始执行/);
    assert.match(copy.guidance, /调整计划/);
    assert.match(copy.guidance, /取消计划/);
  });
});
