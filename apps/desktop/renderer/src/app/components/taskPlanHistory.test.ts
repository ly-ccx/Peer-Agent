import assert from 'node:assert/strict';
import test from 'node:test';
import type { GoalPlan } from '@peer-agent/protocol';
import { groupTaskPlans } from './taskPlanHistory.ts';

function plan(planId: string, status: GoalPlan['status'], updatedAt: string): GoalPlan {
  return {
    planId,
    conversationId: 'conversation-1',
    workflowKind: 'goal_self_driven',
    title: planId,
    goal: planId,
    status,
    tasks: [],
    progress: { total: 0, completed: 0, failed: 0, blocked: 0, percent: 0 },
    boundaries: { inScope: [], outOfScope: [] },
    successCriteria: [],
    criterionResults: [],
    exceptionPolicies: [],
    involvedFiles: [],
    version: 1,
    revisionHistory: [],
    evidenceRefs: [],
    createdAt: updatedAt,
    updatedAt,
  };
}

test('groups the newest active GoalPlan as current and keeps all others as history', () => {
  const result = groupTaskPlans([
    plan('old-completed', 'completed', '2026-08-01T00:00:00.000Z'),
    plan('current', 'executing', '2026-08-03T00:00:00.000Z'),
    plan('new-failed', 'failed', '2026-08-04T00:00:00.000Z'),
  ]);
  assert.equal(result.current?.planId, 'current');
  assert.deepEqual(result.historical.map((item) => item.planId), ['new-failed', 'old-completed']);
});

test('a discussion Task with no GoalPlans has an explicit empty current/history state', () => {
  assert.deepEqual(groupTaskPlans([]), { current: null, historical: [] });
});
