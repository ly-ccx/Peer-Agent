import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GoalPlan } from '@peer-agent/protocol';
import { shouldShowGoalCompletionFeedback } from './goalCompletionFeedback.ts';

function plan(overrides: Partial<GoalPlan>): GoalPlan {
  return {
    planId: 'plan-1',
    title: 'Completion feedback test',
    goal: 'Map lifecycle state to completion feedback',
    status: 'completed',
    workflowKind: 'goal_self_driven',
    activation: { kind: 'accepted_goal' },
    tasks: [],
    progress: { total: 1, completed: 1, failed: 0, blocked: 0, percent: 100 },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as GoalPlan;
}

describe('goal completion feedback', () => {
  it('does not celebrate a completed intake draft', () => {
    assert.equal(shouldShowGoalCompletionFeedback(plan({
      activation: { kind: 'intake' },
    })), false);
  });

  it('celebrates a completed accepted Goal', () => {
    assert.equal(shouldShowGoalCompletionFeedback(plan({
      activation: { kind: 'accepted_goal' },
    })), true);
  });

  it('celebrates a completed approved plan', () => {
    assert.equal(shouldShowGoalCompletionFeedback(plan({
      workflowKind: 'plan_approval',
      activation: { kind: 'approved_plan' },
    })), true);
  });

  it('does not celebrate a formal Goal before completion', () => {
    assert.equal(shouldShowGoalCompletionFeedback(plan({
      status: 'executing',
    })), false);
  });
});
